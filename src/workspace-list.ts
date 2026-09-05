import { createHash } from "node:crypto";
import { join } from "node:path";

import { computeRawSha256, type Sha256Digest } from "./digests.js";
import { DiagnosticError, diagnostic, fail } from "./diagnostics.js";
import { verifyLoadedProjectSnapshot } from "./project.js";
import type { LoadedProject } from "./project.js";
import type { Diagnostic } from "./types.js";
import { findWorkspaceAssetCollisions } from "./workspace-collisions.js";
import {
  computeWorkspaceChildSeal,
  compareWorkspaceUtf8,
  openWorkspaceFile,
  verifyWorkspaceSnapshot,
  withWorkspaceChild,
  type OpenWorkspace,
  type WorkspaceProjectV1,
  type WorkspaceStreamMetrics,
} from "./workspace.js";

export const WORKSPACE_LIST_VIEW_BASIS = "tfsb-workspace-list-view-v1" as const;
export const WORKSPACE_LIST_CURSOR_BASIS = "tfsb-workspace-list-cursor-v1" as const;
export const WORKSPACE_LIST_CURSOR_SCHEMA_VERSION = 1 as const;
export const DEFAULT_WORKSPACE_PAGE_SIZE = 64;
export const MAX_WORKSPACE_PAGE_SIZE = 128;

export type WorkspaceRecordKind = "asset" | "companion";
export interface WorkspaceRecordKey { readonly projectId: string; readonly kind: WorkspaceRecordKind; readonly id: string; }
export interface WorkspaceListRecord {
  readonly projectId: string;
  readonly projectPath: string;
  readonly collections: readonly string[];
  readonly kind: WorkspaceRecordKind;
  readonly id: string;
  readonly qualifiedIdentity: string;
  readonly path: string;
  readonly destinations: readonly string[];
}
export interface WorkspaceListCursorV1 {
  readonly schemaVersion: 1;
  readonly operation: "list";
  readonly workspaceDigest: Sha256Digest;
  readonly pageSize: number;
  readonly lastKey: WorkspaceRecordKey;
  readonly checksum: Sha256Digest;
}
export interface WorkspaceListResult {
  readonly workspace: { readonly id: string; readonly name: string; readonly digest: Sha256Digest; readonly projectCount: number; readonly recordCount: number };
  readonly page: { readonly size: number; readonly recordCount: number; readonly records: readonly WorkspaceListRecord[]; readonly nextCursor: string | null };
  readonly diagnostics: readonly Diagnostic[];
  readonly viewDigest: Sha256Digest;
}
export interface WorkspaceListOptions {
  readonly workspaceFile: string;
  readonly pageSize?: number;
  readonly cursor?: string;
  readonly metrics?: WorkspaceStreamMetrics;
  readonly hooks?: WorkspaceListHooks;
}
export interface WorkspaceListHooks {
  readonly checkCancelled?: () => void;
  readonly onProgress?: (completedProjects: number, totalProjects: number) => void;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ctx = { operation: "list" as const, domain: "workspace" as const };

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(ctx, "CURSOR_INVALID", "Workspace cursor must be a closed JSON object.");
  return value as Record<string, unknown>;
}
function keyOf(record: WorkspaceListRecord): WorkspaceRecordKey {
  return { projectId: record.projectId, kind: record.kind, id: record.id };
}
function sameKey(left: WorkspaceRecordKey, right: WorkspaceRecordKey): boolean {
  return left.projectId === right.projectId && left.kind === right.kind && left.id === right.id;
}
function cursorPayload(cursor: Omit<WorkspaceListCursorV1, "checksum">): string {
  return JSON.stringify(cursor);
}
function cursorChecksum(cursor: Omit<WorkspaceListCursorV1, "checksum">, viewDigest: Sha256Digest): Sha256Digest {
  const payload = cursorPayload(cursor);
  const integrity = computeRawSha256(Buffer.from(`${WORKSPACE_LIST_CURSOR_BASIS}\n${payload}\n`, "utf8")).slice(0, 32);
  const binding = computeRawSha256(Buffer.from(`${WORKSPACE_LIST_CURSOR_BASIS}\n${payload}\n${viewDigest}\n`, "utf8")).slice(0, 32);
  return `sha256:${integrity}${binding}`;
}
function invalidCursor(message: string): never { fail(ctx, "CURSOR_INVALID", message); }

export function parseWorkspaceListCursor(encoded: string): WorkspaceListCursorV1 {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) invalidCursor("Workspace cursor is not canonical unpadded base64url.");
  let text: string;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) invalidCursor("Workspace cursor is not canonical unpadded base64url.");
    text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
  } catch { invalidCursor("Workspace cursor is not valid UTF-8 base64url."); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { invalidCursor("Workspace cursor JSON is invalid."); }
  const root = object(parsed);
  if (!exactKeys(root, ["schemaVersion", "operation", "workspaceDigest", "pageSize", "lastKey", "checksum"])) invalidCursor("Workspace cursor fields are not closed or canonical.");
  const key = object(root.lastKey);
  if (!exactKeys(key, ["projectId", "kind", "id"])) invalidCursor("Workspace cursor key fields are not closed or canonical.");
  if (root.schemaVersion !== 1 || root.operation !== "list") invalidCursor("Workspace cursor version or operation is invalid.");
  if (typeof root.workspaceDigest !== "string" || !SHA256.test(root.workspaceDigest)) invalidCursor("Workspace cursor digest is invalid.");
  if (!Number.isInteger(root.pageSize) || (root.pageSize as number) < 1 || (root.pageSize as number) > MAX_WORKSPACE_PAGE_SIZE) invalidCursor("Workspace cursor page size is invalid.");
  if (typeof key.projectId !== "string" || !ID.test(key.projectId) || (key.kind !== "asset" && key.kind !== "companion") || typeof key.id !== "string" || key.id === "" || key.id.includes("/") || key.id.includes("\\") || key.id.includes("\0")) invalidCursor("Workspace cursor boundary key is invalid.");
  if (typeof root.checksum !== "string" || !SHA256.test(root.checksum)) invalidCursor("Workspace cursor checksum is invalid.");
  const cursor = root as unknown as WorkspaceListCursorV1;
  if (JSON.stringify(cursor) !== text) invalidCursor("Workspace cursor JSON is not canonical.");
  return cursor;
}

export function serializeWorkspaceListCursor(cursor: WorkspaceListCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function createWorkspaceListCursor(
  workspaceDigest: Sha256Digest,
  viewDigest: Sha256Digest,
  pageSize: number,
  lastKey: WorkspaceRecordKey,
): string {
  const payload = { schemaVersion: 1 as const, operation: "list" as const, workspaceDigest, pageSize, lastKey };
  return serializeWorkspaceListCursor({ ...payload, checksum: cursorChecksum(payload, viewDigest) });
}

function recordsForChild(child: WorkspaceProjectV1, loaded: LoadedProject): readonly WorkspaceListRecord[] {
  const installs = new Map(loaded.project.installs.map((item) => [item.asset, item.destinations]));
  const assets: WorkspaceListRecord[] = [...loaded.assets].sort((left, right) => compareWorkspaceUtf8(left.id, right.id)).map((asset) => ({
    projectId: child.id, projectPath: child.path, collections: child.collections,
    kind: "asset", id: asset.id, qualifiedIdentity: `${child.id}/${asset.id}`,
    path: join(loaded.project.buildDirectory, asset.filename).replaceAll("\\", "/"),
    destinations: [...(installs.get(asset.id) ?? [])].sort(compareWorkspaceUtf8),
  }));
  const companions = new Map<string, readonly string[]>(loaded.project.companions.map((item) => [item.file, item.destinations]));
  return [...assets, ...[...loaded.companions.keys()].sort(compareWorkspaceUtf8).map((file): WorkspaceListRecord => ({
    projectId: child.id, projectPath: child.path, collections: child.collections,
    kind: "companion", id: file, qualifiedIdentity: `${child.id}/companion/${file}`,
    path: `.tfsb/companions/${file}`, destinations: [...(companions.get(file) ?? [])].sort(compareWorkspaceUtf8),
  }))];
}

async function childFailure(child: WorkspaceProjectV1, action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) {
    const code = error instanceof DiagnosticError ? error.diagnostic.code : "INTERNAL_ERROR";
    fail(ctx, "WORKSPACE_CHILD_LOAD_FAILED", `Child '${child.id}' could not be listed (${code}).`, child.path);
  }
}

export async function listWorkspace(options: WorkspaceListOptions): Promise<WorkspaceListResult> {
  options.hooks?.checkCancelled?.();
  const pageSize = options.pageSize ?? DEFAULT_WORKSPACE_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_WORKSPACE_PAGE_SIZE) fail(ctx, "WORKSPACE_PAGE_SIZE_INVALID", "Workspace page size must be an integer from 1 through 128.");
  const cursor = options.cursor === undefined ? undefined : parseWorkspaceListCursor(options.cursor);
  if (cursor !== undefined && cursor.pageSize !== pageSize) invalidCursor("Workspace cursor page size does not match --page-size.");
  if (cursor !== undefined) {
    const { checksum: _checksum, ...payload } = cursor;
    const integrity = computeRawSha256(Buffer.from(`${WORKSPACE_LIST_CURSOR_BASIS}\n${cursorPayload(payload)}\n`, "utf8")).slice(0, 32);
    if (!cursor.checksum.startsWith(`sha256:${integrity}`)) invalidCursor("Workspace cursor payload checksum is invalid.");
  }
  const opened = await openWorkspaceFile(options.workspaceFile);
  if (cursor !== undefined && cursor.workspaceDigest !== opened.workspaceDigest) fail(ctx, "CURSOR_STALE", "Workspace cursor does not match the current workspace manifest.");

  const view = createHash("sha256");
  view.update(`${WORKSPACE_LIST_VIEW_BASIS}\n${opened.workspaceDigest}\n`);
  const candidates: WorkspaceListRecord[] = [];
  const seals = new Map<string, Sha256Digest>();
  let total = 0;
  let boundaryFound = cursor === undefined;
  for (const [childIndex, child] of opened.workspace.projects.entries()) {
    options.hooks?.checkCancelled?.();
    await childFailure(child, async () => withWorkspaceChild(opened, child, "list", async ({ loaded }) => {
      seals.set(child.id, computeWorkspaceChildSeal(loaded));
      for (const record of recordsForChild(child, loaded)) {
        options.hooks?.checkCancelled?.();
        view.update(`${JSON.stringify(record)}\n`);
        total += 1;
        if (!boundaryFound) {
          if (sameKey(keyOf(record), cursor!.lastKey)) boundaryFound = true;
        } else if (candidates.length <= pageSize) candidates.push(record);
      }
      await verifyLoadedProjectSnapshot(loaded, "list");
    }, options.metrics));
    options.hooks?.onProgress?.(childIndex + 1, opened.workspace.projects.length);
  }
  const viewDigest = `sha256:${view.digest("hex")}` as Sha256Digest;
  if (cursor !== undefined) {
    const { checksum: _checksum, ...payload } = cursor;
    if (cursor.checksum !== cursorChecksum(payload, viewDigest)) fail(ctx, "CURSOR_STALE", "Workspace cursor no longer matches the current child view.");
    if (!boundaryFound) invalidCursor("Workspace cursor boundary does not exist in the current list stream.");
  }

  for (const child of opened.workspace.projects) {
    options.hooks?.checkCancelled?.();
    try {
      await withWorkspaceChild(opened, child, "list", async ({ loaded }) => {
        if (computeWorkspaceChildSeal(loaded) !== seals.get(child.id)) fail(ctx, "WORKSPACE_CHILD_CHANGED", `Child '${child.id}' changed during workspace listing.`, child.path);
        await verifyLoadedProjectSnapshot(loaded, "list");
      }, options.metrics);
    } catch {
      fail(ctx, "WORKSPACE_CHILD_CHANGED", `Child '${child.id}' changed during workspace listing.`, child.path);
    }
  }
  await verifyWorkspaceSnapshot(opened);

  const records = candidates.slice(0, pageSize);
  const hasMore = candidates.length > pageSize;
  let nextCursor: string | null = null;
  if (hasMore) {
    const last = records.at(-1)!;
    const payload = { schemaVersion: 1 as const, operation: "list" as const, workspaceDigest: opened.workspaceDigest, pageSize, lastKey: keyOf(last) };
    nextCursor = serializeWorkspaceListCursor({ ...payload, checksum: cursorChecksum(payload, viewDigest) });
  }
  const diagnostics = await findWorkspaceAssetCollisions(opened, "list", options.metrics, options.hooks ?? {});
  return {
    workspace: { id: opened.workspace.id, name: opened.workspace.name, digest: opened.workspaceDigest, projectCount: opened.workspace.projects.length, recordCount: total },
    page: { size: pageSize, recordCount: records.length, records, nextCursor },
    diagnostics,
    viewDigest,
  };
}
