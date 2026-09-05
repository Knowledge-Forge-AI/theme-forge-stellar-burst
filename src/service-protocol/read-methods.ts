import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { executeCompleteAnalysis } from "../analyze.js";
import { computeAssetSemanticDigest, computeRawSha256, computeSha256, computeSvgOutputDigest } from "../digests.js";
import { DiagnosticError } from "../diagnostics.js";
import { diffAssetModels } from "../diff.js";
import { validateAssetProposal } from "../edit.js";
import { listProject } from "../list.js";
import { parsePreviewMarker, PREVIEW_MARKER_FILENAME } from "../preview.js";
import { type AnyNormalizedAsset } from "../schema-dispatch.js";
import { checkWorkspace } from "../workspace-check.js";
import { findWorkspaceAssetCollisions } from "../workspace-collisions.js";
import {
  createWorkspaceListCursor, listWorkspace, type WorkspaceListRecord, type WorkspaceRecordKey,
} from "../workspace-list.js";
import { verifyLoadedProjectSnapshot, type LoadedProject } from "../project.js";
import { computeWorkspaceChildSeal, verifyWorkspaceSnapshot, withWorkspaceChild } from "../workspace.js";
import type { CursorScope } from "./cursor.js";
import { ProtocolError } from "./errors.js";
import type { ProjectRecord, SourceRecord, WorkspaceRecord } from "./handles.js";
import type { StudioSession } from "./session.js";
import { brandReadLane, executeBrandRead } from "./brand-methods.js";
import type {
  AssetDiffParams, AssetGetParams, AssetListParams, AssetValidateParams, JsonRpcId,
  PreviewStatusParams, ProjectListParams, ProjectOpenParams, SourceAnalyzeParams,
  SourceOpenParams, WorkspaceOpenParams, WorkspaceStatusParams, StudioBrandReadMethodLatest,
} from "./v1-types.js";
import { BRAND_READ_METHODS, BRAND_READ_METHODS_1_2, type SupportedRequestMethod } from "./v1-registry.js";

type Progress = (stage: "started" | "scanning" | "complete", completed: number, total?: number) => void;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function check(signal: AbortSignal): void { if (signal.aborted) throw new ProtocolError("REQUEST_CANCELLED"); }

function assetById(project: LoadedProject, assetId: string): AnyNormalizedAsset {
  const asset = project.assets.find((item) => item.id === assetId);
  if (asset === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED", `.tfsb/assets/${assetId}.toml`);
  return asset;
}

function assetDto(project: LoadedProject, assetId: string): unknown {
  const asset = assetById(project, assetId);
  const canonicalBytes = project.canonicalFiles.get(`.tfsb/assets/${assetId}.toml`);
  const svgBytes = project.outputs.get(asset.filename);
  if (canonicalBytes === undefined || svgBytes === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
  const canonicalToml = new TextDecoder("utf8", { fatal: true }).decode(canonicalBytes);
  const canonicalSvg = new TextDecoder("utf8", { fatal: true }).decode(svgBytes);
  return {
    assetId, canonicalToml, model: asset, canonicalSvg,
    digests: {
      rawToml: computeSha256(canonicalBytes), semantic: computeAssetSemanticDigest(asset),
      svg: computeSvgOutputDigest(svgBytes),
    },
  };
}

async function workspaceProject(record: WorkspaceRecord, projectId: string): Promise<LoadedProject> {
  const child = record.opened.workspace.projects.find((item) => item.id === projectId);
  if (child === undefined) throw new ProtocolError("ROOT_HANDLE_INVALID");
  return withWorkspaceChild(record.opened, child, "list", async ({ loaded }) => loaded);
}

function lastKey(records: readonly WorkspaceListRecord[]): WorkspaceRecordKey {
  const record = records.at(-1);
  if (record === undefined) throw new ProtocolError("CURSOR_INVALID");
  return { projectId: record.projectId, kind: record.kind, id: record.id };
}

async function workspaceStateDigest(record: WorkspaceRecord, signal: AbortSignal): Promise<`sha256:${string}`> {
  const hash = createHash("sha256"); hash.update(`tfsb-studio-workspace-state-v1\n${record.opened.workspaceDigest}\n`);
  for (const child of record.opened.workspace.projects) {
    check(signal);
    await withWorkspaceChild(record.opened, child, "list", async ({ loaded }) => {
      hash.update(`${child.id}\0${computeWorkspaceChildSeal(loaded)}\n`);
      await verifyLoadedProjectSnapshot(loaded, "list");
    });
  }
  await verifyWorkspaceSnapshot(record.opened);
  return `sha256:${hash.digest("hex")}`;
}

async function listWorkspaceAssets(
  session: StudioSession, record: WorkspaceRecord, handle: string, pageSize: number,
  cursor: string | undefined, signal: AbortSignal, progress: Progress,
): Promise<unknown> {
  const scope: CursorScope = { method: "asset.list", kind: "workspace", handle };
  const decoded = cursor === undefined ? undefined : session.cursors.decode(cursor, scope, pageSize);
  let currentState: `sha256:${string}`;
  try { currentState = await workspaceStateDigest(record, signal); }
  catch (error) { if (decoded !== undefined) throw new ProtocolError("CURSOR_STALE"); throw error; }
  if (decoded !== undefined && decoded.viewDigest !== currentState) throw new ProtocolError("CURSOR_STALE");
  if (decoded !== undefined && decoded.streamDigest === undefined) throw new ProtocolError("CURSOR_INVALID");
  if (decoded?.lastKey.kind === "brand") throw new ProtocolError("CURSOR_INVALID");
  let cliCursor = decoded === undefined ? undefined : createWorkspaceListCursor(record.opened.workspaceDigest, decoded.streamDigest as `sha256:${string}`, pageSize, decoded.lastKey);
  const assets: WorkspaceListRecord[] = [];
  let latest: Awaited<ReturnType<typeof listWorkspace>> | undefined;
  while (assets.length <= pageSize) {
    check(signal);
    try {
      latest = await listWorkspace({
        workspaceFile: record.opened.manifestPath, pageSize, ...(cliCursor === undefined ? {} : { cursor: cliCursor }),
        hooks: { checkCancelled: () => check(signal), onProgress: (done, total) => progress("scanning", done, total) },
      });
    } catch (error) {
      if (cursor !== undefined && error instanceof DiagnosticError && error.diagnostic.code === "CURSOR_STALE") throw new ProtocolError("CURSOR_STALE");
      throw error;
    }
    assets.push(...latest.page.records.filter((item) => item.kind === "asset"));
    if (latest.page.nextCursor === null || assets.length > pageSize) break;
    cliCursor = latest.page.nextCursor;
  }
  if (latest === undefined) throw new ProtocolError("INTERNAL_ERROR");
  if (decoded !== undefined && decoded.streamDigest !== latest.viewDigest) throw new ProtocolError("CURSOR_STALE");
  try { currentState = await workspaceStateDigest(record, signal); }
  catch (error) { if (decoded !== undefined) throw new ProtocolError("CURSOR_STALE"); throw error; }
  if (decoded !== undefined && decoded.viewDigest !== currentState) throw new ProtocolError("CURSOR_STALE");
  const page = assets.slice(0, pageSize);
  const hasMore = assets.length > pageSize || latest.page.nextCursor !== null;
  const nextCursor = hasMore && page.length > 0 ? session.cursors.encode({
    protocolVersion: "1.0", scope, viewDigest: currentState, streamDigest: latest.viewDigest, lastKey: lastKey(page), pageSize,
  }) : null;
  return {
    scope: { kind: "workspace", workspaceId: latest.workspace.id },
    page: {
      size: pageSize, count: page.length,
      items: page.map((item) => ({ projectId: item.projectId, assetId: item.id, qualifiedIdentity: item.qualifiedIdentity, collections: item.collections, buildPath: item.path, destinations: item.destinations })),
      nextCursor,
    },
    viewDigest: currentState,
  };
}

async function previewStatus(record: ProjectRecord, project: LoadedProject): Promise<unknown> {
  const outputIdentity = ".tfsb-preview";
  const root = join(record.root, outputIdentity);
  const rootStat = await lstat(root).catch(() => undefined);
  if (rootStat === undefined) return { status: "absent", outputIdentity, markerDigest: null };
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { status: "unowned/invalid", outputIdentity, markerDigest: null };
  const markerPath = join(root, PREVIEW_MARKER_FILENAME);
  const markerStat = await lstat(markerPath).catch(() => undefined);
  if (markerStat === undefined || !markerStat.isFile() || markerStat.isSymbolicLink()) return { status: "unowned/invalid", outputIdentity, markerDigest: null };
  const markerBytes = await readFile(markerPath);
  const parsed = parsePreviewMarker(new TextDecoder("utf8", { fatal: true }).decode(markerBytes));
  if (parsed.status !== "valid" || parsed.marker.outputDirectory !== outputIdentity) return { status: "unowned/invalid", outputIdentity, markerDigest: null };
  const top = await readdir(root, { withFileTypes: true });
  const expected = new Set([PREVIEW_MARKER_FILENAME, ...parsed.marker.files.map((item) => item.path.split("/")[0]!)]);
  if (top.some((entry) => entry.isSymbolicLink() || !expected.has(entry.name))) return { status: "unowned/invalid", outputIdentity, markerDigest: computeSha256(markerBytes) };
  let drift = parsed.marker.assets.length !== project.assets.length;
  for (const asset of project.assets) {
    const markerAsset = parsed.marker.assets.find((item) => item.id === asset.id && item.filename === asset.filename);
    const output = project.outputs.get(asset.filename);
    if (markerAsset === undefined || output === undefined || markerAsset.sha256 !== computeRawSha256(output)) drift = true;
  }
  for (const item of parsed.marker.files) {
    const file = join(root, ...item.path.split("/"));
    const stat = await lstat(file).catch(() => undefined);
    if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) { drift = true; continue; }
    if (computeRawSha256(await readFile(file)) !== item.sha256) drift = true;
  }
  return { status: drift ? "owned-drift" : "owned-clean", outputIdentity, markerDigest: computeSha256(markerBytes), assetCount: parsed.marker.assets.length };
}

export class ReadMethods {
  constructor(readonly session: StudioSession) {}

  lane(method: SupportedRequestMethod, params: unknown): string {
    if (([...BRAND_READ_METHODS, ...BRAND_READ_METHODS_1_2] as readonly string[]).includes(method)) return brandReadLane(this.session, method as StudioBrandReadMethodLatest, params);
    if (method === "workspace.open" || method === "project.open" || method === "source.open") return `open:${method}:${Math.random()}`;
    if (method === "workspace.status") return this.session.handles.laneFor("workspace", (params as WorkspaceStatusParams).workspaceHandle);
    if (method === "project.list" || method === "preview.status" || method === "asset.validate" || method === "asset.diff") return this.session.handles.laneFor("project", (params as ProjectListParams | PreviewStatusParams | AssetValidateParams).projectHandle);
    if (method === "asset.get") { const scope = (params as AssetGetParams).scope; return this.session.handles.laneFor(scope.kind, scope.kind === "project" ? scope.projectHandle : scope.workspaceHandle); }
    if (method === "asset.list") { const scope = (params as AssetListParams).scope; return this.session.handles.laneFor(scope.kind, scope.kind === "project" ? scope.projectHandle : scope.workspaceHandle); }
    if (method === "source.analyze") return this.session.handles.laneFor("source", (params as SourceAnalyzeParams).sourceHandle);
    return `session:${method}`;
  }

  async execute(method: SupportedRequestMethod, params: unknown, signal: AbortSignal, _requestId: JsonRpcId, progress: Progress): Promise<unknown> {
    check(signal); progress("started", 0);
    let result: unknown;
    if (([...BRAND_READ_METHODS, ...BRAND_READ_METHODS_1_2] as readonly string[]).includes(method)) result = await executeBrandRead(this.session, method as StudioBrandReadMethodLatest, params, signal);
    else if (method === "workspace.open") result = await this.session.handles.openWorkspace((params as WorkspaceOpenParams).path);
    else if (method === "project.open") {
      const value = params as ProjectOpenParams;
      result = await this.session.handles.openProject(value.path, value.mode ?? "existing");
    }
    else if (method === "source.open") {
      const value = params as SourceOpenParams;
      result = await this.session.handles.openSource(value.path, { ...(value.purpose === undefined ? {} : { purpose: value.purpose }), checkCancelled: () => check(signal) });
    }
    else if (method === "workspace.status") {
      const value = params as WorkspaceStatusParams; const record = await this.session.handles.workspace(value.workspaceHandle);
      if (value.mode === "check") result = await checkWorkspace({ workspaceFile: record.opened.manifestPath, hooks: { checkCancelled: () => check(signal), onProgress: (done, total) => progress("scanning", done, total) } });
      else {
        let loadable = 0; let failed = 0;
        for (const [index, child] of record.opened.workspace.projects.entries()) {
          check(signal);
          try { await withWorkspaceChild(record.opened, child, "discover", async ({ loaded }) => verifyLoadedProjectSnapshot(loaded, "discover")); loadable += 1; }
          catch { failed += 1; }
          progress("scanning", index + 1, record.opened.workspace.projects.length);
        }
        const diagnostics = await findWorkspaceAssetCollisions(record.opened, "list", undefined, { checkCancelled: () => check(signal) });
        await verifyWorkspaceSnapshot(record.opened);
        result = { workspaceId: record.opened.workspace.id, name: record.opened.workspace.name, digest: record.opened.workspaceDigest, totalProjects: record.opened.workspace.projects.length, loadable, failed, diagnostics: diagnostics.map((item) => ({ code: item.code, location: item.location ?? null })) };
      }
    } else if (method === "project.list") {
      const value = params as ProjectListParams; const { record } = await this.session.handles.project(value.projectHandle);
      result = await listProject(record.root);
    } else if (method === "asset.list") {
      const value = params as AssetListParams;
      if (value.scope.kind === "workspace") {
        let record: WorkspaceRecord;
        try { record = await this.session.handles.workspace(value.scope.workspaceHandle); }
        catch (error) { if (value.cursor !== undefined && error instanceof ProtocolError && error.symbolicCode === "ROOT_INVALID") throw new ProtocolError("CURSOR_STALE"); throw error; }
        result = await listWorkspaceAssets(this.session, record, value.scope.workspaceHandle, value.pageSize, value.cursor, signal, progress);
      } else {
        const { loaded, digest } = await this.session.handles.project(value.scope.projectHandle);
        const scope: CursorScope = { method: "asset.list", kind: "project", handle: value.scope.projectHandle };
        const decoded = value.cursor === undefined ? undefined : this.session.cursors.decode(value.cursor, scope, value.pageSize);
        if (decoded !== undefined && decoded.viewDigest !== digest) throw new ProtocolError("CURSOR_STALE");
        const assets = [...loaded.assets].sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
        const start = decoded === undefined ? 0 : assets.findIndex((item) => item.id === decoded.lastKey.id) + 1;
        if (decoded !== undefined && start === 0) throw new ProtocolError("CURSOR_INVALID");
        const page = assets.slice(start, start + value.pageSize); const hasMore = start + page.length < assets.length;
        result = { scope: { kind: "project" }, page: { size: value.pageSize, count: page.length, items: page.map((item) => ({ assetId: item.id, filename: item.filename })), nextCursor: hasMore ? this.session.cursors.encode({ protocolVersion: "1.0", scope, viewDigest: digest, lastKey: { projectId: "project", kind: "asset", id: page.at(-1)!.id }, pageSize: value.pageSize }) : null }, viewDigest: digest };
        await verifyLoadedProjectSnapshot(loaded, "list");
      }
    } else if (method === "asset.get") {
      const value = params as AssetGetParams;
      const loaded = value.scope.kind === "project" ? (await this.session.handles.project(value.scope.projectHandle)).loaded : await workspaceProject(await this.session.handles.workspace(value.scope.workspaceHandle), value.scope.projectId);
      result = assetDto(loaded, value.scope.assetId); await verifyLoadedProjectSnapshot(loaded, "list");
    } else if (method === "asset.validate" || method === "asset.diff") {
      const value = params as AssetValidateParams | AssetDiffParams; const { loaded } = await this.session.handles.project(value.projectHandle);
      const proposed = validateAssetProposal(loaded, value.assetId, value.toml);
      result = method === "asset.validate" || !proposed.valid ? proposed : { valid: true, ...diffAssetModels(assetById(loaded, value.assetId), proposed.model), proposedDigest: proposed.digests.semantic };
      await verifyLoadedProjectSnapshot(loaded, "list");
    } else if (method === "source.analyze") {
      const value = params as SourceAnalyzeParams; const record: SourceRecord = await this.session.handles.source(value.sourceHandle);
      const scope: CursorScope = { method: "source.analyze", kind: "source", handle: value.sourceHandle };
      const decoded = value.cursor === undefined ? undefined : this.session.cursors.decode(value.cursor, scope, value.pageSize);
      if (decoded !== undefined && decoded.viewDigest !== record.digest) throw new ProtocolError("CURSOR_STALE");
      let analysis;
      try { analysis = await executeCompleteAnalysis(record.plan, { checkCancelled: () => check(signal), onProgress: (done, total) => progress("scanning", done, total) }); }
      catch (error) { if (value.cursor !== undefined && error instanceof DiagnosticError && error.diagnostic.code === "ANALYZE_SOURCE_CHANGED") throw new ProtocolError("CURSOR_STALE"); throw error; }
      const start = decoded === undefined ? 0 : analysis.files.findIndex((item) => item.path === decoded.lastKey.id) + 1;
      if (decoded !== undefined && start === 0) throw new ProtocolError("CURSOR_INVALID");
      const page = value.includeDetails ? analysis.files.slice(start, start + value.pageSize) : [];
      const hasMore = value.includeDetails && start + page.length < analysis.files.length;
      result = {
        sourceKind: record.plan.kind, status: analysis.status,
        summary: { totals: analysis.data.totals, profiles: analysis.data.profiles, resourceObservations: analysis.data.resourceObservations, identity: analysis.data.identity },
        details: { count: page.length, items: page.map((item) => ({ path: item.path, derivedAssetId: item.derivedAssetId, profiles: item.profiles })), nextCursor: hasMore ? this.session.cursors.encode({ protocolVersion: "1.0", scope, viewDigest: record.digest, lastKey: { projectId: "source", kind: "asset", id: page.at(-1)!.path }, pageSize: value.pageSize }) : null },
      };
    } else if (method === "preview.status") {
      const value = params as PreviewStatusParams; const { record, loaded } = await this.session.handles.project(value.projectHandle);
      result = await previewStatus(record, loaded); await verifyLoadedProjectSnapshot(loaded, "preview");
    } else throw new ProtocolError("METHOD_NOT_FOUND");
    check(signal); progress("complete", 1, 1); return result;
  }
}
