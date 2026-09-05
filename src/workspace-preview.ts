import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

import { computeRawSha256, computeSha256, type Sha256Digest } from "./digests.js";
import { DiagnosticError, fail } from "./diagnostics.js";
import { durableWrite, optionalLstat, readRegularFileSnapshot, sameFileSnapshot, syncPath } from "./filesystem.js";
import { verifyLoadedProjectSnapshot } from "./project.js";
import { resolveConfinedPath } from "./root.js";
import { portablePathKey, validatePortablePathValue } from "./source-identity.js";
import { TOOL_VERSION } from "./version.js";
import { findWorkspaceAssetCollisions } from "./workspace-collisions.js";
import {
  computeWorkspaceChildSeal,
  compareWorkspaceUtf8,
  openWorkspaceFile,
  verifyWorkspaceSnapshot,
  withWorkspaceChild,
  type WorkspaceStreamMetrics,
} from "./workspace.js";

export const DEFAULT_WORKSPACE_PREVIEW_OUTPUT = ".tfsb-workspace-preview" as const;
export const WORKSPACE_PREVIEW_MARKER_FILENAME = ".tfsb-preview.json" as const;
export const WORKSPACE_PREVIEW_MARKER_KIND = "tfsb-workspace-preview-v1" as const;
export const WORKSPACE_PREVIEW_VIEW_BASIS = "tfsb-workspace-preview-view-v1" as const;
export const WORKSPACE_PREVIEW_TREE_BASIS = "tfsb-workspace-preview-tree-v1" as const;
export const WORKSPACE_PREVIEW_PAGE_SIZE = 128;

export interface WorkspacePreviewMarker {
  readonly kind: typeof WORKSPACE_PREVIEW_MARKER_KIND;
  readonly schemaVersion: 1;
  readonly toolVersion: string;
  readonly workspaceId: string;
  readonly workspaceDigest: Sha256Digest;
  readonly viewDigest: Sha256Digest;
  readonly outputDirectory: string;
  readonly fileCount: number;
  readonly treeDigest: Sha256Digest;
}
export interface WorkspacePreviewMetrics extends WorkspaceStreamMetrics {
  pageAssets: number;
  maxPageAssets: number;
}
export interface WorkspacePreviewHooks {
  readonly afterStage?: (stage: string) => void | Promise<void>;
  readonly afterBackup?: (backup: string) => void | Promise<void>;
  readonly afterPromote?: (output: string) => void | Promise<void>;
  readonly beforeBackupCleanup?: (backup: string) => void | Promise<void>;
}
export interface WorkspacePreviewOptions {
  readonly workspaceFile: string;
  readonly output?: string;
  readonly metrics?: WorkspacePreviewMetrics;
}
export interface WorkspacePreviewResult {
  readonly workspace: { readonly id: string; readonly name: string; readonly digest: Sha256Digest };
  readonly outputDirectory: string;
  readonly written: true;
  readonly replaced: boolean;
  readonly projectCount: number;
  readonly assetCount: number;
  readonly companionCount: number;
  readonly pageCount: number;
  readonly viewDigest: Sha256Digest;
  readonly marker: typeof WORKSPACE_PREVIEW_MARKER_FILENAME;
  readonly fileCount: number;
  readonly treeDigest: Sha256Digest;
}

type TreeIdentity = { readonly fileCount: number; readonly treeDigest: Sha256Digest };
type TargetSnapshot = { readonly kind: "absent" } | {
  readonly kind: "owned";
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly ctimeMs: number;
  readonly markerDigest: string;
  readonly marker: WorkspacePreviewMarker;
  readonly tree: TreeIdentity;
};

const ctx = { operation: "preview" as const, domain: "workspace" as const };
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function overlaps(left: string, right: string): boolean {
  const l = portablePathKey(left);
  const r = portablePathKey(right);
  return l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`);
}
function identity(stat: Stats): Pick<Extract<TargetSnapshot, { kind: "owned" }>, "dev" | "ino" | "mode" | "ctimeMs"> {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, ctimeMs: stat.ctimeMs };
}
function sameTarget(left: TargetSnapshot, right: TargetSnapshot): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.ctimeMs === right.ctimeMs &&
    left.markerDigest === right.markerDigest && left.tree.fileCount === right.tree.fileCount && left.tree.treeDigest === right.tree.treeDigest;
}

export function parseWorkspacePreviewMarker(text: string): WorkspacePreviewMarker {
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail(ctx, "WORKSPACE_PREVIEW_MARKER_INVALID", "Workspace preview marker JSON is invalid."); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(ctx, "WORKSPACE_PREVIEW_MARKER_INVALID", "Workspace preview marker must be an object.");
  const marker = value as Record<string, unknown>;
  if (!exactKeys(marker, ["kind", "schemaVersion", "toolVersion", "workspaceId", "workspaceDigest", "viewDigest", "outputDirectory", "fileCount", "treeDigest"])) fail(ctx, "WORKSPACE_PREVIEW_MARKER_INVALID", "Workspace preview marker fields are not closed or canonical.");
  if (marker.kind !== WORKSPACE_PREVIEW_MARKER_KIND || marker.schemaVersion !== 1 || typeof marker.toolVersion !== "string" || typeof marker.workspaceId !== "string" || typeof marker.workspaceDigest !== "string" || !SHA256.test(marker.workspaceDigest) || typeof marker.viewDigest !== "string" || !SHA256.test(marker.viewDigest) || typeof marker.outputDirectory !== "string" || !Number.isSafeInteger(marker.fileCount) || (marker.fileCount as number) < 2 || typeof marker.treeDigest !== "string" || !SHA256.test(marker.treeDigest)) fail(ctx, "WORKSPACE_PREVIEW_MARKER_INVALID", "Workspace preview marker values are invalid.");
  if (JSON.stringify(marker, null, 2) + "\n" !== text) fail(ctx, "WORKSPACE_PREVIEW_MARKER_INVALID", "Workspace preview marker JSON is not canonical.");
  return marker as unknown as WorkspacePreviewMarker;
}
export function serializeWorkspacePreviewMarker(marker: WorkspacePreviewMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

async function* walkFiles(root: string, relativeDirectory = ""): AsyncGenerator<string> {
  const directory = relativeDirectory === "" ? root : join(root, relativeDirectory);
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview contains an unsafe directory.", relativeDirectory || ".");
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareWorkspaceUtf8(left.name, right.name))) {
    const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview contains a symlink.", path);
    if (entry.isDirectory()) yield* walkFiles(root, path);
    else if (entry.isFile()) yield path;
    else fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview contains a special file.", path);
  }
  const after = await lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview directory changed during inspection.", relativeDirectory || ".");
}

export async function computeWorkspacePreviewTree(root: string): Promise<TreeIdentity> {
  const hash = createHash("sha256");
  hash.update(`${WORKSPACE_PREVIEW_TREE_BASIS}\n`);
  let fileCount = 0;
  for await (const path of walkFiles(root)) {
    if (path === WORKSPACE_PREVIEW_MARKER_FILENAME) continue;
    const read = await readRegularFileSnapshot(join(root, path), ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview file changed or became unsafe.");
    hash.update(`${path}\t${computeRawSha256(read.bytes)}\n`);
    fileCount += 1;
  }
  return { fileCount, treeDigest: `sha256:${hash.digest("hex")}` as Sha256Digest };
}

async function captureTarget(path: string, outputDirectory: string): Promise<TargetSnapshot> {
  const before = await optionalLstat(path);
  if (before === undefined) return { kind: "absent" };
  if (!before.isDirectory() || before.isSymbolicLink()) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview target is not an owned non-symlink directory.", outputDirectory);
  const top = await readdir(path, { withFileTypes: true });
  const topNames = new Set(["index.html", "styles.css", "projects", "assets", WORKSPACE_PREVIEW_MARKER_FILENAME]);
  if (top.length !== topNames.size || top.some((entry) => !topNames.has(entry.name)) || top.some((entry) => entry.name === "projects" || entry.name === "assets" ? !entry.isDirectory() || entry.isSymbolicLink() : !entry.isFile() || entry.isSymbolicLink())) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview has an unexpected top-level layout.", outputDirectory);
  const assetProjects = await readdir(join(path, "assets"), { withFileTypes: true });
  const pageProjects = await readdir(join(path, "projects"), { withFileTypes: true });
  if (assetProjects.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()) || pageProjects.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()) || assetProjects.map((entry) => entry.name).sort(compareWorkspaceUtf8).join("\0") !== pageProjects.map((entry) => entry.name).sort(compareWorkspaceUtf8).join("\0")) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview project directories are unsafe or inconsistent.", outputDirectory);
  for (const project of assetProjects) {
    const assets = await readdir(join(path, "assets", project.name), { withFileTypes: true });
    const pages = await readdir(join(path, "projects", project.name), { withFileTypes: true });
    if (assets.length === 0 || pages.length === 0 || assets.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.svg$/.test(entry.name)) || pages.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !/^page-[0-9]{4}\.html$/.test(entry.name))) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview project layout is unsafe.", project.name);
  }
  const markerRead = await readRegularFileSnapshot(join(path, WORKSPACE_PREVIEW_MARKER_FILENAME), ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview marker is missing or unsafe.");
  let marker: WorkspacePreviewMarker;
  try { marker = parseWorkspacePreviewMarker(Buffer.from(markerRead.bytes).toString("utf8")); }
  catch { fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview marker is invalid.", outputDirectory); }
  if (marker.outputDirectory !== outputDirectory) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview marker does not match the configured output.", outputDirectory);
  const tree = await computeWorkspacePreviewTree(path);
  const confirmedTree = await computeWorkspacePreviewTree(path);
  if (tree.fileCount !== confirmedTree.fileCount || tree.treeDigest !== confirmedTree.treeDigest) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview tree changed during ownership inspection.", outputDirectory);
  const markerAfter = await readRegularFileSnapshot(join(path, WORKSPACE_PREVIEW_MARKER_FILENAME), ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview marker changed or became unsafe.");
  if (!sameFileSnapshot(markerRead.snapshot, markerAfter.snapshot)) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview marker changed during ownership inspection.", outputDirectory);
  if (tree.fileCount !== marker.fileCount || tree.treeDigest !== marker.treeDigest) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview tree does not match its marker.", outputDirectory);
  const after = await lstat(path);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs) fail(ctx, "WORKSPACE_PREVIEW_UNOWNED", "Workspace preview target changed during ownership inspection.", outputDirectory);
  return { kind: "owned", ...identity(after), markerDigest: computeRawSha256(markerRead.bytes), marker, tree };
}

const CSS = `:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }\n* { box-sizing: border-box; }\nbody { margin: 0; padding: 1.5rem; background: #07111f; color: #eef6ff; }\na { color: #8bd5ff; }\n.projects, .assets { display: grid; gap: 1rem; }\n.card { padding: 1rem; border: 1px solid #38506b; border-radius: .75rem; background: #102237; }\n.asset { display: grid; grid-template-columns: 8rem 1fr; gap: 1rem; align-items: center; }\n.asset img { width: 8rem; height: 8rem; object-fit: contain; background: #fff; }\ncode { overflow-wrap: anywhere; }\n`;

interface ProjectSummary { readonly id: string; readonly name: string; readonly path: string; readonly collections: readonly string[]; readonly assetCount: number; readonly companionCount: number; readonly pageCount: number; }
interface PageAsset { readonly id: string; readonly destinations: readonly string[]; }

export function* paginateWorkspacePreviewAssets<T>(assets: readonly T[]): Generator<readonly T[]> {
  for (let offset = 0; offset < assets.length; offset += WORKSPACE_PREVIEW_PAGE_SIZE) {
    yield assets.slice(offset, offset + WORKSPACE_PREVIEW_PAGE_SIZE);
  }
}

export function renderWorkspacePreviewPage(workspaceName: string, project: ProjectSummary, page: number, assets: readonly PageAsset[]): string {
  const cards = assets.map((asset) => `<article class="card asset"><img src="../../assets/${encodeURIComponent(project.id)}/${encodeURIComponent(asset.id)}.svg" alt=""><div><h2>${escapeHtml(asset.id)}</h2><p><code>${escapeHtml(`${project.id}/${asset.id}`)}</code></p><p>Destinations: ${asset.destinations.length === 0 ? "none" : asset.destinations.map(escapeHtml).join(", ")}</p></div></article>`).join("\n");
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; script-src 'none'; object-src 'none'; connect-src 'none'; font-src 'none'">\n<title>${escapeHtml(project.name)} - ${escapeHtml(workspaceName)}</title>\n<link rel="stylesheet" href="../../styles.css">\n</head>\n<body>\n<p><a href="../../index.html">Workspace index</a></p>\n<h1>${escapeHtml(project.name)}</h1>\n<p>Project <code>${escapeHtml(project.id)}</code>; page ${page + 1} of ${project.pageCount}.</p>\n<main class="assets">${cards}</main>\n</body>\n</html>\n`;
}

function renderIndex(name: string, id: string, digest: string, projects: readonly ProjectSummary[]): string {
  const cards = projects.map((project) => `<article class="card"><h2>${project.pageCount === 0 ? escapeHtml(project.name) : `<a href="projects/${encodeURIComponent(project.id)}/page-0001.html">${escapeHtml(project.name)}</a>`}</h2><p><code>${escapeHtml(project.id)}</code> at <code>${escapeHtml(project.path)}</code></p><p>Collections: ${project.collections.length === 0 ? "none" : project.collections.map(escapeHtml).join(", ")}</p><p>${project.assetCount} asset(s); ${project.companionCount} companion(s).</p></article>`).join("\n");
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; script-src 'none'; object-src 'none'; connect-src 'none'; font-src 'none'">\n<title>${escapeHtml(name)}</title>\n<link rel="stylesheet" href="styles.css">\n</head>\n<body>\n<h1>${escapeHtml(name)}</h1>\n<p>Workspace <code>${escapeHtml(id)}</code>; manifest <code>${escapeHtml(digest)}</code>.</p>\n<main class="projects">${cards}</main>\n</body>\n</html>\n`;
}

function validateOutput(output: string, projects: readonly { readonly path: string }[]): void {
  validatePortablePathValue(output, ctx, "output", { allowDot: true });
  if (output === "." || overlaps(output, ".tfsb-workspace.toml")) fail(ctx, "WORKSPACE_PREVIEW_UNSAFE_OUTPUT", "Workspace preview output overlaps the manifest.", output);
  for (const child of projects) if (overlaps(output, child.path)) fail(ctx, "WORKSPACE_PREVIEW_UNSAFE_OUTPUT", "Workspace preview output overlaps a child project.", output);
}

export async function previewWorkspace(options: WorkspacePreviewOptions, hooks: WorkspacePreviewHooks = {}): Promise<WorkspacePreviewResult> {
  const opened = await openWorkspaceFile(options.workspaceFile);
  const outputDirectory = options.output ?? DEFAULT_WORKSPACE_PREVIEW_OUTPUT;
  validateOutput(outputDirectory, opened.workspace.projects);
  const outputPath = await resolveConfinedPath(opened.root, outputDirectory, "preview");
  const target = await captureTarget(outputPath, outputDirectory);
  const parent = dirname(outputPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await resolveConfinedPath(opened.root, outputDirectory, "preview");
  const token = randomUUID();
  const stage = join(parent, `.${basename(outputPath)}.tfsb-stage-${token}`);
  const backup = join(parent, `.${basename(outputPath)}.tfsb-backup-${token}`);
  const summaries: ProjectSummary[] = [];
  const seals = new Map<string, string>();
  const view = createHash("sha256");
  view.update(`${WORKSPACE_PREVIEW_VIEW_BASIS}\n${opened.workspaceDigest}\n`);
  let assetCount = 0;
  let companionCount = 0;
  let pageCount = 0;
  let promoted = false;
  let backupCreated = false;
  try {
    const collisions = await findWorkspaceAssetCollisions(opened, "preview", options.metrics);
    if (collisions.length > 0) throw new DiagnosticError(collisions[0]!);
    await mkdir(stage, { mode: 0o700 });
    await mkdir(join(stage, "projects"), { mode: 0o700 });
    await mkdir(join(stage, "assets"), { mode: 0o700 });
    await durableWrite(join(stage, "styles.css"), Buffer.from(CSS, "utf8"));
    for (const child of opened.workspace.projects) {
      try {
        await withWorkspaceChild(opened, child, "preview", async ({ loaded }) => {
          seals.set(child.id, computeWorkspaceChildSeal(loaded));
          const sortedAssets = [...loaded.assets].sort((left, right) => compareWorkspaceUtf8(left.id, right.id));
          const summary: ProjectSummary = { id: child.id, name: loaded.project.name, path: child.path, collections: child.collections, assetCount: sortedAssets.length, companionCount: loaded.companions.size, pageCount: Math.ceil(sortedAssets.length / WORKSPACE_PREVIEW_PAGE_SIZE) };
          summaries.push(summary);
          assetCount += sortedAssets.length;
          companionCount += loaded.companions.size;
          pageCount += summary.pageCount;
          view.update(`${JSON.stringify({ projectId: child.id, projectPath: child.path, collections: child.collections, projectName: loaded.project.name, buildDirectory: loaded.project.buildDirectory, installs: loaded.project.installs, companions: loaded.project.companions, companionFiles: [...loaded.companions.keys()].sort(compareWorkspaceUtf8) })}\n`);
          if (sortedAssets.length > 0) {
            await mkdir(join(stage, "projects", child.id), { recursive: false, mode: 0o700 });
            await mkdir(join(stage, "assets", child.id), { recursive: false, mode: 0o700 });
          }
          let page = 0;
          for (const pageAssets of paginateWorkspacePreviewAssets(sortedAssets)) {
            if (options.metrics !== undefined) {
              options.metrics.pageAssets = pageAssets.length;
              options.metrics.maxPageAssets = Math.max(options.metrics.maxPageAssets, pageAssets.length);
            }
            const rendered: PageAsset[] = [];
            for (const asset of pageAssets) {
              const bytes = loaded.outputs.get(asset.filename)!;
              const destinations = [...(loaded.project.installs.find((item) => item.asset === asset.id)?.destinations ?? [])].sort(compareWorkspaceUtf8);
              view.update(`${JSON.stringify({ projectId: child.id, assetId: asset.id, filename: asset.filename, svgDigest: computeSha256(bytes), destinations })}\n`);
              await durableWrite(join(stage, "assets", child.id, `${asset.id}.svg`), bytes);
              rendered.push({ id: asset.id, destinations });
            }
            await durableWrite(join(stage, "projects", child.id, `page-${String(page + 1).padStart(4, "0")}.html`), Buffer.from(renderWorkspacePreviewPage(opened.workspace.name, summary, page, rendered), "utf8"));
            if (options.metrics !== undefined) options.metrics.pageAssets = 0;
            page += 1;
          }
          if (sortedAssets.length > 0) {
            await syncPath(join(stage, "projects", child.id));
            await syncPath(join(stage, "assets", child.id));
          }
          await verifyLoadedProjectSnapshot(loaded, "preview");
        }, options.metrics);
      } catch (error) {
        if (error instanceof DiagnosticError) throw error;
        fail(ctx, "WORKSPACE_CHILD_LOAD_FAILED", `Child '${child.id}' could not be previewed.`, child.path);
      }
    }
    await durableWrite(join(stage, "index.html"), Buffer.from(renderIndex(opened.workspace.name, opened.workspace.id, opened.workspaceDigest, summaries), "utf8"));
    await syncPath(join(stage, "projects"));
    await syncPath(join(stage, "assets"));
    const viewDigest = `sha256:${view.digest("hex")}` as Sha256Digest;
    const tree = await computeWorkspacePreviewTree(stage);
    const marker: WorkspacePreviewMarker = { kind: WORKSPACE_PREVIEW_MARKER_KIND, schemaVersion: 1, toolVersion: TOOL_VERSION, workspaceId: opened.workspace.id, workspaceDigest: opened.workspaceDigest, viewDigest, outputDirectory, fileCount: tree.fileCount, treeDigest: tree.treeDigest };
    await durableWrite(join(stage, WORKSPACE_PREVIEW_MARKER_FILENAME), Buffer.from(serializeWorkspacePreviewMarker(marker), "utf8"));
    await syncPath(stage);
    const staged = await captureTarget(stage, outputDirectory);
    if (staged.kind !== "owned" || staged.marker.viewDigest !== viewDigest) fail(ctx, "WORKSPACE_PREVIEW_STAGE_INVALID", "Workspace preview stage failed validation.");
    await hooks.afterStage?.(stage);
    await captureTarget(stage, outputDirectory);
    for (const child of opened.workspace.projects) {
      try {
        await withWorkspaceChild(opened, child, "preview", async ({ loaded }) => {
          if (computeWorkspaceChildSeal(loaded) !== seals.get(child.id)) fail(ctx, "WORKSPACE_CHILD_CHANGED", `Child '${child.id}' changed during workspace preview.`, child.path);
          await verifyLoadedProjectSnapshot(loaded, "preview");
        }, options.metrics);
      } catch {
        fail(ctx, "WORKSPACE_CHILD_CHANGED", `Child '${child.id}' changed during workspace preview.`, child.path);
      }
    }
    await verifyWorkspaceSnapshot(opened);
    const beforeRename = await captureTarget(outputPath, outputDirectory);
    if (!sameTarget(target, beforeRename)) fail(ctx, "WORKSPACE_PREVIEW_TARGET_CHANGED", "Workspace preview target changed after planning.", outputDirectory);
    if (beforeRename.kind === "owned") {
      await rename(outputPath, backup);
      backupCreated = true;
      await hooks.afterBackup?.(backup);
    }
    if (await optionalLstat(outputPath) !== undefined) fail(ctx, "WORKSPACE_PREVIEW_TARGET_CHANGED", "Workspace preview target appeared during promotion.", outputDirectory);
    await rename(stage, outputPath);
    promoted = true;
    await hooks.afterPromote?.(outputPath);
    await syncPath(parent);
    if (backupCreated) {
      try { await hooks.beforeBackupCleanup?.(backup); await rm(backup, { recursive: true }); backupCreated = false; }
      catch { fail(ctx, "WORKSPACE_PREVIEW_BACKUP_CLEANUP_FAILED", "New workspace preview is active but backup cleanup failed.", outputDirectory); }
      await syncPath(parent);
    }
    return { workspace: { id: opened.workspace.id, name: opened.workspace.name, digest: opened.workspaceDigest }, outputDirectory, written: true, replaced: target.kind === "owned", projectCount: summaries.length, assetCount, companionCount, pageCount, viewDigest, marker: WORKSPACE_PREVIEW_MARKER_FILENAME, fileCount: tree.fileCount, treeDigest: tree.treeDigest };
  } catch (error) {
    if (!promoted) {
      let rollbackFailed = false;
      if (backupCreated) await rename(backup, outputPath).catch(() => { rollbackFailed = true; });
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (rollbackFailed) fail(ctx, "WORKSPACE_PREVIEW_ROLLBACK_FAILED", "Workspace preview rollback failed.", outputDirectory);
    }
    throw error;
  }
}
