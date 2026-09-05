import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { parse as parseToml, TomlError } from "smol-toml";

import { DiagnosticError, diagnostic, fail, fromCaught, ok, type DiagnosticContext } from "./diagnostics.js";
import { computeSha256, type Sha256Digest } from "./digests.js";
import { readRegularFileSnapshot, sameFileSnapshot, type FileSnapshot } from "./filesystem.js";
import { loadCanonicalProject } from "./project.js";
import type { LoadedProject } from "./project.js";
import { portablePathKey, validatePortablePathValue } from "./source-identity.js";
import type { AnyNormalizedProject } from "./schema-dispatch.js";
import type { Diagnostic, Result } from "./types.js";

export const WORKSPACE_FILENAME = ".tfsb-workspace.toml" as const;
export const WORKSPACE_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_DIGEST_BASIS = "tfsb-workspace-v1" as const;
export const WORKSPACE_MAX_BYTES = 1024 * 1024;
export const WORKSPACE_MAX_PROJECTS = 1024;

export interface WorkspaceProjectV1 {
  readonly id: string;
  readonly path: string;
  readonly collections: readonly string[];
}

export interface WorkspaceV1 {
  readonly schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly projects: readonly WorkspaceProjectV1[];
}

export interface DiscoveredWorkspaceProject {
  readonly id: string;
  readonly path: string;
  readonly collections: readonly string[];
  readonly project: AnyNormalizedProject;
  readonly assetIds: readonly string[];
  readonly qualifiedAssetIds: readonly string[];
}

export interface WorkspaceDiscoveryResult {
  readonly workspace: WorkspaceV1;
  readonly workspaceDigest: Sha256Digest;
  readonly projects: ReadonlyMap<string, DiscoveredWorkspaceProject>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface OpenWorkspace {
  readonly root: string;
  readonly manifestPath: string;
  readonly workspace: WorkspaceV1;
  readonly workspaceDigest: Sha256Digest;
  readonly manifestSnapshot: FileSnapshot;
}

export interface WorkspaceStreamMetrics {
  loadedChildren: number;
  maxLoadedChildren: number;
}

export interface WorkspaceChildVisit {
  readonly child: WorkspaceProjectV1;
  readonly root: string;
  readonly loaded: LoadedProject;
}

export function computeWorkspaceChildSeal(project: Pick<LoadedProject, "snapshot">): Sha256Digest {
  const snapshot = project.snapshot;
  const directories = [...snapshot.directoryIdentities]
    .sort(([left], [right]) => compareWorkspaceUtf8(left, right))
    .map(([path, identity]) => [path, identity.dev, identity.ino, identity.mode, identity.size, identity.mtimeMs, identity.ctimeMs]);
  const files = [...snapshot.files]
    .sort(([left], [right]) => compareWorkspaceUtf8(left, right))
    .map(([path, file]) => [path, file.digest, file.dev, file.ino, file.mode, file.size, file.mtimeMs, file.ctimeMs]);
  return computeSha256(Buffer.from(JSON.stringify({
    basis: "tfsb-workspace-child-snapshot-v1",
    rootDev: snapshot.rootDev,
    rootIno: snapshot.rootIno,
    canonicalDev: snapshot.canonicalDev,
    canonicalIno: snapshot.canonicalIno,
    directories,
    files,
  }), "utf8"));
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function context(source?: string): DiagnosticContext {
  const safeSource = source !== undefined && !source.startsWith("/") && !source.includes("\\") && !/^[A-Za-z]:/.test(source) ? source : undefined;
  return { operation: "discover", domain: "workspace", ...(safeSource === undefined ? {} : { source: safeSource }) };
}

function record(value: unknown, ctx: DiagnosticContext, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(ctx, "WORKSPACE_INVALID_TYPE", "Workspace value must be a table.", location);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], ctx: DiagnosticContext, location: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) fail(ctx, "WORKSPACE_UNKNOWN_FIELD", `Unknown workspace field '${unknown}'.`, `${location}.${unknown}`);
}

function string(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") fail(ctx, "WORKSPACE_INVALID_TYPE", "Expected a string.", location);
  return value;
}

function id(value: unknown, ctx: DiagnosticContext, location: string): string {
  const parsed = string(value, ctx, location);
  if (!ID.test(parsed)) fail(ctx, "WORKSPACE_INVALID_ID", "Workspace and collection IDs must use canonical kebab grammar.", location);
  return parsed;
}

export function compareWorkspaceUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function parseDocument(value: unknown, ctx: DiagnosticContext): WorkspaceV1 {
  const root = record(value, ctx, "workspace");
  exactKeys(root, ["schema_version", "id", "name", "project"], ctx, "workspace");
  if (root.schema_version !== WORKSPACE_SCHEMA_VERSION) fail(ctx, "WORKSPACE_UNSUPPORTED_VERSION", "Workspace schema_version must be 1.", "schema_version");
  const workspaceId = id(root.id, ctx, "id");
  const name = string(root.name, ctx, "name");
  if (name.trim() === "") fail(ctx, "WORKSPACE_INVALID_NAME", "Workspace name cannot be blank.", "name");
  const rawProjects = root.project === undefined ? [] : root.project;
  if (!Array.isArray(rawProjects)) fail(ctx, "WORKSPACE_INVALID_TYPE", "project must be an array of tables.", "project");
  if (rawProjects.length > WORKSPACE_MAX_PROJECTS) fail(ctx, "WORKSPACE_PROJECT_LIMIT", `Workspace contains more than ${WORKSPACE_MAX_PROJECTS} child projects.`, "project");
  const projects = rawProjects.map((value, index): WorkspaceProjectV1 => {
    const location = `project[${index}]`;
    const project = record(value, ctx, location);
    exactKeys(project, ["id", "path", "collections"], ctx, location);
    const projectId = id(project.id, ctx, `${location}.id`);
    const path = string(project.path, ctx, `${location}.path`);
    validatePortablePathValue(path, ctx, `${location}.path`);
    if (!Array.isArray(project.collections) || project.collections.some((item) => typeof item !== "string")) fail(ctx, "WORKSPACE_INVALID_TYPE", "collections must be an array of collection IDs.", `${location}.collections`);
    const collections = (project.collections as string[]).map((value, collectionIndex) => id(value, ctx, `${location}.collections[${collectionIndex}]`));
    const collectionKeys = new Set<string>();
    for (const collectionId of collections) {
      if (collectionKeys.has(collectionId)) fail(ctx, "WORKSPACE_DUPLICATE_COLLECTION", `Collection '${collectionId}' is duplicated.`, `${location}.collections`);
      collectionKeys.add(collectionId);
    }
    return { id: projectId, path, collections: [...collections].sort(compareWorkspaceUtf8) };
  }).sort((left, right) => compareWorkspaceUtf8(left.id, right.id));
  const ids = new Set<string>();
  const paths = new Map<string, string>();
  for (const project of projects) {
    if (ids.has(project.id)) fail(ctx, "WORKSPACE_DUPLICATE_PROJECT", `Project id '${project.id}' is duplicated.`, project.id);
    ids.add(project.id);
    const key = portablePathKey(project.path);
    if (paths.has(key)) fail(ctx, "WORKSPACE_DUPLICATE_PATH", "Child project paths must be portably unique.", project.path);
    paths.set(key, project.path);
  }
  for (let index = 0; index < projects.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < projects.length; otherIndex += 1) {
      const left = portablePathKey(projects[index]!.path);
      const right = portablePathKey(projects[otherIndex]!.path);
      if (right.startsWith(`${left}/`) || left.startsWith(`${right}/`)) fail(ctx, "WORKSPACE_CHILD_OVERLAP", "Child project paths must not overlap.", right);
    }
  }
  return { schemaVersion: WORKSPACE_SCHEMA_VERSION, id: workspaceId, name, projects };
}

export function parseWorkspace(text: string, source?: string): Result<WorkspaceV1> {
  const ctx = context(source);
  try {
    if (Buffer.byteLength(text, "utf8") > WORKSPACE_MAX_BYTES) fail(ctx, "WORKSPACE_SIZE_LIMIT", "Workspace manifest exceeds 1 MiB.", WORKSPACE_FILENAME);
    return ok(parseDocument(parseToml(text.replace(/^\uFEFF/, "")), ctx));
  } catch (error) {
    return fromCaught(error, ctx, "WORKSPACE_INVALID_TOML", "Workspace TOML is invalid.", (caught) => caught instanceof TomlError);
  }
}

function basic(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007F").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function serializeWorkspace(value: WorkspaceV1): string {
  const parsed = parseDocument({ schema_version: value.schemaVersion, id: value.id, name: value.name, project: value.projects.map((project) => ({ id: project.id, path: project.path, collections: [...project.collections] })) }, context());
  const lines = ["schema_version = 1", `id = ${basic(parsed.id)}`, `name = ${basic(parsed.name)}`];
  for (const project of parsed.projects) lines.push("", "[[project]]", `id = ${basic(project.id)}`, `path = ${basic(project.path)}`, `collections = [${project.collections.map(basic).join(", ")}]`);
  const serialized = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(serialized, "utf8") > WORKSPACE_MAX_BYTES) fail(context(), "WORKSPACE_SIZE_LIMIT", "Workspace manifest exceeds 1 MiB.", WORKSPACE_FILENAME);
  return serialized;
}

export function computeWorkspaceDigest(value: WorkspaceV1): Sha256Digest {
  return computeSha256(Buffer.from(`${WORKSPACE_DIGEST_BASIS}\n${serializeWorkspace(value)}`, "utf8"));
}

async function resolveChild(root: string, path: string, ctx: DiagnosticContext): Promise<string> {
  let current = resolve(root);
  const rootStat = await lstat(current).catch(() => undefined);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(ctx, "WORKSPACE_UNSAFE_ROOT", "Workspace root must be a non-symlink directory.");
  for (const component of path.split("/")) {
    current = resolve(current, component);
    const stat = await lstat(current).catch(() => undefined);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail(ctx, "WORKSPACE_UNSAFE_CHILD", "Child path components must be non-symlink directories.", path);
  }
  const manifest = await lstat(resolve(current, ".tfsb/project.toml")).catch(() => undefined);
  if (!manifest || !manifest.isFile() || manifest.isSymbolicLink()) fail(ctx, "WORKSPACE_PROJECT_MISSING", "Child must contain a real .tfsb/project.toml.", `${path}/.tfsb/project.toml`);
  return current;
}

export async function openWorkspaceFile(file: string): Promise<OpenWorkspace> {
  const ctx = context(WORKSPACE_FILENAME);
  const manifestPath = resolve(file);
  if (basename(manifestPath) !== WORKSPACE_FILENAME) {
    fail(ctx, "WORKSPACE_INVALID_FILENAME", `Workspace file must be named '${WORKSPACE_FILENAME}'.`, WORKSPACE_FILENAME);
  }
  const root = dirname(manifestPath);
  const rootStat = await lstat(root).catch(() => undefined);
  if (rootStat === undefined || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(ctx, "WORKSPACE_UNSAFE_ROOT", "Workspace root must be a non-symlink directory.");
  }
  const read = await readRegularFileSnapshot(
    manifestPath,
    ctx,
    "WORKSPACE_UNSAFE_MANIFEST",
    "Workspace manifest must be a bounded regular non-symlink file.",
    WORKSPACE_MAX_BYTES,
  );
  const parsed = parseWorkspace(Buffer.from(read.bytes).toString("utf8"), WORKSPACE_FILENAME);
  if (!parsed.ok) throw new DiagnosticError(parsed.diagnostics[0]!);
  return {
    root,
    manifestPath,
    workspace: parsed.value,
    workspaceDigest: computeWorkspaceDigest(parsed.value),
    manifestSnapshot: read.snapshot,
  };
}

export async function verifyWorkspaceSnapshot(opened: OpenWorkspace): Promise<void> {
  const current = await readRegularFileSnapshot(
    opened.manifestPath,
    context(WORKSPACE_FILENAME),
    "WORKSPACE_SOURCE_CHANGED",
    "Workspace manifest changed during aggregation.",
    WORKSPACE_MAX_BYTES,
  );
  if (!sameFileSnapshot(opened.manifestSnapshot, current.snapshot)) {
    fail(context(WORKSPACE_FILENAME), "WORKSPACE_SOURCE_CHANGED", "Workspace manifest changed during aggregation.", WORKSPACE_FILENAME);
  }
}

export async function visitWorkspaceChildren(
  opened: OpenWorkspace,
  visitor: (visit: WorkspaceChildVisit) => void | Promise<void>,
  metrics?: WorkspaceStreamMetrics,
): Promise<void> {
  for (const child of opened.workspace.projects) {
    await withWorkspaceChild(opened, child, "discover", visitor, metrics);
  }
}

export async function withWorkspaceChild<T>(
  opened: OpenWorkspace,
  child: WorkspaceProjectV1,
  operation: "discover" | "list" | "check" | "preview",
  visitor: (visit: WorkspaceChildVisit) => T | Promise<T>,
  metrics?: WorkspaceStreamMetrics,
): Promise<T> {
  const childRoot = await resolveChild(opened.root, child.path, context(WORKSPACE_FILENAME));
  const loaded = await loadCanonicalProject(childRoot, operation);
  if (metrics !== undefined) {
    metrics.loadedChildren += 1;
    metrics.maxLoadedChildren = Math.max(metrics.maxLoadedChildren, metrics.loadedChildren);
  }
  try {
    return await visitor({ child, root: childRoot, loaded });
  } finally {
    if (metrics !== undefined) metrics.loadedChildren -= 1;
  }
}

export async function discoverWorkspace(root: string): Promise<Result<WorkspaceDiscoveryResult>> {
  const ctx = context(WORKSPACE_FILENAME);
  try {
    const opened = await openWorkspaceFile(resolve(root, WORKSPACE_FILENAME));
    const workspace = opened.workspace;
    const projects = new Map<string, DiscoveredWorkspaceProject>();
    const assets = new Map<string, string[]>();
    const diagnostics: Diagnostic[] = [];
    for (const child of workspace.projects) {
      try {
        const childRoot = await resolveChild(opened.root, child.path, ctx);
        const loaded = await loadCanonicalProject(childRoot, "discover");
        const assetIds = loaded.assets.map((asset) => asset.id).sort(compareWorkspaceUtf8);
        for (const assetId of assetIds) {
          const owners = assets.get(assetId) ?? [];
          owners.push(child.id);
          assets.set(assetId, owners);
        }
        projects.set(child.id, { ...child, project: loaded.project, assetIds, qualifiedAssetIds: assetIds.map((assetId) => `${child.id}/${assetId}`) });
      } catch (error) {
        if (error instanceof DiagnosticError) {
          diagnostics.push(error.diagnostic);
        } else {
          diagnostics.push(diagnostic(ctx, "WORKSPACE_CHILD_LOAD_FAILED", "Child project failed to load.", child.path));
        }
      }
    }
    for (const [assetId, owners] of assets) {
      if (owners.length > 1) diagnostics.push(diagnostic(ctx, "WORKSPACE_ASSET_ID_COLLISION", `Asset ID '${assetId}' is present in ${owners.slice(0, 5).join(", ")}.`, assetId));
    }
    await verifyWorkspaceSnapshot(opened);
    return ok({ workspace, workspaceDigest: opened.workspaceDigest, projects, diagnostics });
  } catch (error) {
    return fromCaught(error, ctx, "WORKSPACE_DISCOVERY_FAILED", "Workspace discovery failed.", (caught) => caught instanceof DiagnosticError || (caught instanceof Error && "code" in caught));
  }
}
