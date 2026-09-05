import { constants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { posix, resolve } from "node:path";

import { ANALYZE_LIMITS } from "./analyze-contract.js";
import { ARCHIVE_LIMITS } from "./archive-limits.js";
import { DiagnosticError, diagnostic, fail, fromCaught, ok, type DiagnosticContext } from "./diagnostics.js";
import { computeSha256, type Sha256Digest } from "./digests.js";
import {
  deriveSourceMapIdentities,
  evaluateSourceMapSelection,
  validatePortablePathValue,
  portablePathKey,
  type SourceIdentity,
  type SourceSelectionCandidate,
} from "./source-identity.js";
import { computeSourceMapDigest, type SourceMapCollectionV1, type SourceMapV1 } from "./source-map.js";
import type { Diagnostic, Result } from "./types.js";
import {
  DIRECTORY_SNAPSHOT_BACKEND,
  loadDirectorySnapshotNative,
  type DirectorySnapshotNativeAddon,
  type DirectorySnapshotPlatformArtifact,
  type NativeDirectoryEntry,
  type NativeHandle,
  type NativeStat,
} from "./directory-snapshot-native.js";
import { inspectPlanRetention, type PlanRetentionInspection } from "./plan-retention.js";

export const DIRECTORY_SNAPSHOT_BASIS = "tfsb-directory-snapshot-v1" as const;
export const DIRECTORY_FILE_BYTES_BASIS = "tfsb-directory-file-bytes-v1" as const;
export const DIRECTORY_SNAPSHOT_UNSUPPORTED = "DIRECTORY_SNAPSHOT_UNSUPPORTED" as const;

export interface UnsupportedDirectorySnapshotCapability {
  readonly supported: false;
  readonly code: typeof DIRECTORY_SNAPSHOT_UNSUPPORTED;
  readonly backend: "none" | "stock-node-path-api";
  readonly missingPrimitive?: "handle-relative-openat-equivalent";
  readonly platformArtifact?: DirectorySnapshotPlatformArtifact | "none";
  readonly filesystemClass?: "qualified-local" | "unsupported";
}
export interface SupportedDirectorySnapshotCapability {
  readonly supported: true;
  readonly backend: typeof DIRECTORY_SNAPSHOT_BACKEND;
  readonly platformArtifact: DirectorySnapshotPlatformArtifact;
  readonly filesystemClass: "qualified-local";
}
export type DirectorySnapshotCapability = UnsupportedDirectorySnapshotCapability | SupportedDirectorySnapshotCapability;
export type DirectorySnapshotQualification = DirectorySnapshotCapability & {
  readonly rootHandleOpened: boolean;
  readonly handleRelativeDirectoryOpen: boolean;
  readonly handleRelativeFileOpen: boolean;
  readonly handleRelativeStat: boolean;
  readonly noFollowLeafOpen: boolean;
  readonly descriptorIdentityCheck: boolean;
};

export interface DirectoryChildDto { readonly name: string; readonly kind: "directory" | "file" }
export interface DirectoryInventoryDto { readonly path: string; readonly kind: "directory"; readonly children: readonly DirectoryChildDto[] }
export interface DirectoryFileDto extends SourceIdentity {
  readonly kind: "file";
  readonly byteCount: number;
  readonly sourceBasis: typeof DIRECTORY_FILE_BYTES_BASIS;
  readonly sourceDigest: Sha256Digest;
}
export interface DirectoryCompanionDto {
  readonly collectionId: string;
  readonly sourcePath: string;
  readonly kind: "file";
  readonly byteCount: number;
  readonly sourceBasis: typeof DIRECTORY_FILE_BYTES_BASIS;
  readonly sourceDigest: Sha256Digest;
}
export interface DirectorySnapshotSelectionOptions {
  readonly selectedPaths?: readonly string[];
  readonly companions?: readonly { readonly collectionId: string; readonly sourcePath: string }[];
  /** Reconcile-only tracked paths: absent entries remain authenticated by parent inventory. */
  readonly optionalCompanions?: readonly { readonly collectionId: string; readonly sourcePath: string }[];
}
export interface DirectoryDiscoveryResult {
  readonly authenticated: false;
  readonly sourceMapDigest: Sha256Digest;
  readonly inventoryDigest: Sha256Digest;
  readonly directories: readonly DirectoryInventoryDto[];
  readonly files: readonly DirectoryFileDto[];
  readonly diagnostics: readonly Diagnostic[];
}
export interface DirectoryDiscoveryOptions {
  readonly selectedPaths?: readonly string[];
}
export interface DirectoryRevalidationResult {
  readonly authenticated: false;
  readonly portableContentUnchanged: true;
  readonly inventoryDigest: Sha256Digest;
}

export interface AuthenticatedDirectorySnapshot {
  readonly authenticated: true;
  readonly backend: typeof DIRECTORY_SNAPSHOT_BACKEND;
  readonly platformArtifact: DirectorySnapshotPlatformArtifact;
  readonly filesystemClass: "qualified-local";
  readonly sourceMapDigest: Sha256Digest;
  readonly inventoryDigest: Sha256Digest;
  readonly directories: readonly DirectoryInventoryDto[];
  readonly files: readonly DirectoryFileDto[];
  readonly companions: readonly DirectoryCompanionDto[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface AuthenticatedDirectoryRevalidationResult {
  readonly authenticated: true;
  readonly portableContentUnchanged: true;
  readonly inventoryDigest: Sha256Digest;
}

interface ScanState {
  entries: number;
  visibleSvgBytes: number;
  readonly countedEntries: Set<string>;
  readonly visitedDirectories: Set<string>;
  readonly directories: Map<string, DirectoryInventoryDto>;
  readonly candidates: Map<string, SourceSelectionCandidate>;
}

interface NativeDirectoryRecord {
  readonly path: string;
  readonly stat: NativeStat;
  readonly children: readonly NativeDirectoryEntry[];
}

interface NativeFileRecord {
  readonly dto: DirectoryFileDto | DirectoryCompanionDto;
  readonly stat: NativeStat;
  readonly bytes: Buffer;
  readonly handle: NativeHandle;
}

interface NativeSnapshotSession {
  readonly addon: DirectorySnapshotNativeAddon;
  readonly artifact: DirectorySnapshotPlatformArtifact;
  readonly sourceComponents: readonly string[];
  readonly ancestry: readonly NativeHandle[];
  readonly sourceRoot: NativeHandle;
  readonly sourceRootStat: NativeStat;
  readonly directoryRecords: readonly NativeDirectoryRecord[];
  readonly fileRecords: readonly NativeFileRecord[];
  closed: boolean;
}

interface NativeScanState extends ScanState {
  readonly candidateStats: Map<string, NativeStat>;
  readonly nativeDirectories: Map<string, NativeDirectoryRecord>;
}

const nativeSessions = new WeakMap<AuthenticatedDirectorySnapshot, NativeSnapshotSession>();

const NATIVE_DIAGNOSTIC_CODES = new Set([
  "DIRECTORY_ANCESTRY_SYMLINK",
  "DIRECTORY_HARD_LINK",
  "DIRECTORY_INVALID_COMPONENT",
  "DIRECTORY_INVALID_HANDLE",
  "DIRECTORY_NATIVE_ERROR",
  "DIRECTORY_NOT_DIRECTORY",
  "DIRECTORY_SOURCE_CHANGED",
  "DIRECTORY_SPECIAL_FILE",
  "DIRECTORY_TRAVERSED_SYMLINK",
  "DIRECTORY_USE_AFTER_CLOSE",
  "RESOURCE_LIMIT_EXCEEDED",
]);

function context(): DiagnosticContext {
  return { operation: "discover", domain: "directory-snapshot" };
}

function fromNativeCaught<T>(error: unknown, ctx: DiagnosticContext, fallbackCode: string, fallbackMessage: string): Result<T> {
  if (error instanceof DiagnosticError) return { ok: false, diagnostics: [error.diagnostic] };
  if (error instanceof Error && "code" in error && typeof error.code === "string" && NATIVE_DIAGNOSTIC_CODES.has(error.code)) {
    return { ok: false, diagnostics: [diagnostic(ctx, error.code, "Authenticated directory snapshot operation failed safely.")] };
  }
  return { ok: false, diagnostics: [diagnostic(ctx, fallbackCode, fallbackMessage)] };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function joined(left: string, right: string): string {
  if (right === ".") return left;
  return left === "." ? right : `${left}/${right}`;
}

function dtoKind(entry: Dirent): "directory" | "file" | "symlink" | "special" {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "special";
}

async function directoryEntries(path: string, relativePath: string, ctx: DiagnosticContext, state: ScanState): Promise<readonly Dirent[]> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) fail(ctx, "DIRECTORY_TRAVERSED_SYMLINK", "Traversed directory must be a real directory.", relativePath);
  const handle = await opendir(path);
  const entries: Dirent[] = [];
  try {
    for await (const entry of handle) {
      const childPath = joined(relativePath, entry.name);
      if (!state.countedEntries.has(childPath)) {
        if (state.entries >= ANALYZE_LIMITS.candidateEntries) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Directory discovery supports at most ${ANALYZE_LIMITS.candidateEntries} traversed entries.`);
        state.countedEntries.add(childPath);
        state.entries += 1;
      }
      entries.push(entry);
    }
  } finally { await handle.close().catch(() => undefined); }
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  const after = await lstat(path);
  if (!sameIdentity(before, after)) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory source changed during discovery.", relativePath);
  return entries;
}

function recordDirectory(state: ScanState, path: string, children: readonly DirectoryChildDto[], ctx: DiagnosticContext): void {
  const merged = new Map<string, DirectoryChildDto["kind"]>();
  for (const child of state.directories.get(path)?.children ?? []) merged.set(child.name, child.kind);
  for (const child of children) {
    const previous = merged.get(child.name);
    if (previous !== undefined && previous !== child.kind) {
      fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory entry type changed during discovery.", joined(path, child.name));
    }
    merged.set(child.name, child.kind);
  }
  state.directories.set(path, {
    path,
    kind: "directory",
    children: [...merged].sort(([left], [right]) => compareUtf8(left, right)).map(([name, kind]) => ({ name, kind })),
  });
}

async function inspectLeaf(absolutePath: string, relativePath: string, ctx: DiagnosticContext, state: ScanState): Promise<void> {
  const stat = await lstat(absolutePath);
  if (stat.isSymbolicLink()) fail(ctx, "DIRECTORY_TRAVERSED_SYMLINK", "Traversed collection contains a symlink.", relativePath);
  if (!stat.isFile()) fail(ctx, "DIRECTORY_SPECIAL_FILE", "Traversed collection contains a special file.", relativePath);
  if (relativePath.toLowerCase().endsWith(".svg") && !state.candidates.has(relativePath)) {
    if (state.candidates.size >= ANALYZE_LIMITS.svgFiles) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Directory discovery supports at most ${ANALYZE_LIMITS.svgFiles} SVG files.`);
    if (stat.size > ANALYZE_LIMITS.fileBytes) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Visible SVG exceeds ${ANALYZE_LIMITS.fileBytes} bytes.`, relativePath);
    if (state.visibleSvgBytes + stat.size > ANALYZE_LIMITS.aggregateSvgBytes) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Directory discovery exceeds ${ANALYZE_LIMITS.aggregateSvgBytes} visible SVG bytes.`);
    state.visibleSvgBytes += stat.size;
    state.candidates.set(relativePath, { sourcePath: relativePath, kind: "file" });
  }
}

function withinTree(path: string, tree: string): boolean {
  return tree === "." || path === tree || path.startsWith(`${tree}/`);
}

function excludedBy(collection: SourceMapCollectionV1, collectionPath: string): boolean {
  return collection.excludePaths.includes(collectionPath)
    || collection.excludeTrees.some((tree) => withinTree(collectionPath, tree))
    || collection.entries.some((entry) => entry.kind === "exclusion" && entry.sourcePath === collectionPath);
}

async function walkTree(
  root: string,
  relativePath: string,
  collectionPath: string,
  collection: SourceMapCollectionV1,
  ctx: DiagnosticContext,
  state: ScanState,
): Promise<void> {
  if (excludedBy(collection, collectionPath)) return;
  const visitKey = `${collection.id}\0${relativePath}`;
  if (state.visitedDirectories.has(visitKey)) return;
  state.visitedDirectories.add(visitKey);
  const absolutePath = resolve(root, relativePath === "." ? "" : relativePath);
  const entries = await directoryEntries(absolutePath, relativePath, ctx, state);
  const children: DirectoryChildDto[] = [];
  for (const entry of entries) {
    const childPath = joined(relativePath, entry.name);
    const childCollectionPath = joined(collectionPath, entry.name);
    validatePortablePathValue(childPath, ctx, childPath, { allowDot: true });
    if (excludedBy(collection, childCollectionPath)) continue;
    const kind = dtoKind(entry);
    if (kind === "symlink") fail(ctx, "DIRECTORY_TRAVERSED_SYMLINK", "Traversed collection contains a symlink.", childPath);
    if (kind === "special") fail(ctx, "DIRECTORY_SPECIAL_FILE", "Traversed collection contains a special file.", childPath);
    children.push({ name: entry.name, kind });
    if (kind === "directory") await walkTree(root, childPath, childCollectionPath, collection, ctx, state);
    else await inspectLeaf(resolve(root, childPath), childPath, ctx, state);
  }
  recordDirectory(state, relativePath, children, ctx);
}

async function inspectExactPath(root: string, relativePath: string, ctx: DiagnosticContext, state: ScanState): Promise<void> {
  const parts = relativePath.split("/");
  let currentRelative = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    currentRelative = currentRelative === "" ? part : `${currentRelative}/${part}`;
    validatePortablePathValue(currentRelative, ctx, currentRelative);
    if (!state.visitedDirectories.has(currentRelative)) {
      state.visitedDirectories.add(currentRelative);
      const absoluteDir = resolve(root, currentRelative);
      const entries = await directoryEntries(absoluteDir, currentRelative, ctx, state);
      const children: DirectoryChildDto[] = [];
      for (const entry of entries) {
        const kind = dtoKind(entry);
        if (kind === "symlink") fail(ctx, "DIRECTORY_TRAVERSED_SYMLINK", "Traversed collection contains a symlink.", joined(currentRelative, entry.name));
        if (kind === "special") fail(ctx, "DIRECTORY_SPECIAL_FILE", "Traversed collection contains a special file.", joined(currentRelative, entry.name));
        children.push({ name: entry.name, kind });
      }
      recordDirectory(state, currentRelative, children, ctx);
    }
  }
  if (parts.length === 1 && !state.visitedDirectories.has(".")) {
    state.visitedDirectories.add(".");
    const entries = await directoryEntries(resolve(root), ".", ctx, state);
    const children: DirectoryChildDto[] = [];
    for (const entry of entries) {
      const kind = dtoKind(entry);
      if (kind === "symlink") fail(ctx, "DIRECTORY_TRAVERSED_SYMLINK", "Traversed collection contains a symlink.", entry.name);
      if (kind === "special") fail(ctx, "DIRECTORY_SPECIAL_FILE", "Traversed collection contains a special file.", entry.name);
      children.push({ name: entry.name, kind });
    }
    recordDirectory(state, ".", children, ctx);
  }
  validatePortablePathValue(relativePath, ctx, relativePath);
  const absoluteFile = resolve(root, relativePath);
  await inspectLeaf(absoluteFile, relativePath, ctx, state);
}

function selectedCollections(map: SourceMapV1, ids: readonly string[] | undefined, ctx: DiagnosticContext): readonly SourceMapCollectionV1[] {
  if (ids === undefined) return map.collections;
  const unique = new Set(ids);
  if (unique.size !== ids.length) fail(ctx, "DIRECTORY_DUPLICATE_COLLECTION", "Collection selection contains a duplicate ID.");
  const selected = ids.map((id) => {
    const collection = map.collections.find((item) => item.id === id);
    if (collection === undefined) fail(ctx, "DIRECTORY_UNKNOWN_COLLECTION", `Unknown collection '${id}'.`, id);
    return collection;
  });
  return selected.sort((left, right) => compareUtf8(left.id, right.id));
}

function sameNativeStat(left: NativeStat, right: NativeStat): boolean {
  return left.type === right.type
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.linkCount === right.linkCount
    && left.size === right.size
    && left.mtimeSeconds === right.mtimeSeconds
    && left.mtimeNanoseconds === right.mtimeNanoseconds
    && left.ctimeSeconds === right.ctimeSeconds
    && left.ctimeNanoseconds === right.ctimeNanoseconds
    && left.generation === right.generation;
}

function sameNativeIdentity(left: NativeStat, right: NativeStat): boolean {
  return left.type === right.type && left.device === right.device && left.inode === right.inode;
}

function validateNativeComponent(component: string, ctx: DiagnosticContext, path?: string): void {
  if (component.length === 0
      || component === "."
      || component === ".."
      || component.includes("/")
      || component.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(component)) {
    fail(ctx, "DIRECTORY_INVALID_COMPONENT", "Directory component is invalid.", path);
  }
}

function splitSourceRoot(root: string, ctx: DiagnosticContext): readonly string[] {
  if (!posix.isAbsolute(root)) fail(ctx, "DIRECTORY_UNSAFE_ROOT", "Directory source root must be an absolute POSIX path.");
  if (root === "/") return [];
  const components = root.slice(1).split("/");
  for (const component of components) validateNativeComponent(component, ctx);
  return components;
}

function closeNativeHandles(addon: DirectorySnapshotNativeAddon, handles: readonly NativeHandle[]): void {
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    try { addon.closeHandle(handles[index]!); } catch { /* cleanup remains best-effort after the first failure */ }
  }
}

function openSourceAncestry(addon: DirectorySnapshotNativeAddon, components: readonly string[]): readonly NativeHandle[] {
  const handles: NativeHandle[] = [];
  try {
    handles.push(addon.openFilesystemRoot());
    for (const component of components) handles.push(addon.openChildDirectory(handles.at(-1)!, component));
    return handles;
  } catch (error) {
    closeNativeHandles(addon, handles);
    throw error;
  }
}

function openDirectoryFromSource(
  addon: DirectorySnapshotNativeAddon,
  sourceRoot: NativeHandle,
  relativePath: string,
  ctx: DiagnosticContext,
): { readonly handle: NativeHandle; readonly opened: readonly NativeHandle[] } {
  if (relativePath === ".") return { handle: sourceRoot, opened: [] };
  const opened: NativeHandle[] = [];
  let parent = sourceRoot;
  try {
    for (const component of relativePath.split("/")) {
      validateNativeComponent(component, ctx, relativePath);
      const child = addon.openChildDirectory(parent, component);
      opened.push(child);
      parent = child;
    }
    return { handle: parent, opened };
  } catch (error) {
    closeNativeHandles(addon, opened);
    throw error;
  }
}

function nativeEntries(
  addon: DirectorySnapshotNativeAddon,
  handle: NativeHandle,
  relativePath: string,
  ctx: DiagnosticContext,
  state: NativeScanState,
): readonly NativeDirectoryEntry[] {
  const entries = [...addon.readDirectory(handle)].sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    validateNativeComponent(entry.name, ctx, joined(relativePath, entry.name));
    const childPath = joined(relativePath, entry.name);
    if (!state.countedEntries.has(childPath)) {
      if (state.entries >= ANALYZE_LIMITS.candidateEntries) {
        fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Directory snapshot supports at most ${ANALYZE_LIMITS.candidateEntries} traversed entries.`);
      }
      state.countedEntries.add(childPath);
      state.entries += 1;
    }
  }
  return entries;
}

function sameNativeEntries(left: readonly NativeDirectoryEntry[], right: readonly NativeDirectoryEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && entry.name === candidate.name
      && entry.kind === candidate.kind
      && sameNativeStat(entry.stat, candidate.stat);
  });
}

function recordNativeDirectory(
  state: NativeScanState,
  path: string,
  stat: NativeStat,
  allChildren: readonly NativeDirectoryEntry[],
  selectedChildren: readonly DirectoryChildDto[],
  ctx: DiagnosticContext,
): void {
  const previous = state.nativeDirectories.get(path);
  if (previous !== undefined && (!sameNativeStat(previous.stat, stat) || !sameNativeEntries(previous.children, allChildren))) {
    fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory source changed during authenticated traversal.", path);
  }
  state.nativeDirectories.set(path, { path, stat, children: allChildren });
  recordDirectory(state, path, selectedChildren, ctx);
}

function inspectNativeCandidate(
  addon: DirectorySnapshotNativeAddon,
  parent: NativeHandle,
  name: string,
  relativePath: string,
  expectedStat: NativeStat,
  ctx: DiagnosticContext,
  state: NativeScanState,
): void {
  if (!relativePath.toLowerCase().endsWith(".svg") || state.candidates.has(relativePath)) return;
  if (state.candidates.size >= ANALYZE_LIMITS.svgFiles) {
    fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Directory snapshot supports at most ${ANALYZE_LIMITS.svgFiles} SVG files.`);
  }
  const handle = addon.openChildRegular(parent, name);
  try {
    const stat = addon.statHandle(handle);
    if (stat.type !== "file") fail(ctx, "DIRECTORY_SPECIAL_FILE", "Traversed collection contains a special file.", relativePath);
    if (!sameNativeStat(expectedStat, stat)) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory entry changed before authenticated open.", relativePath);
    if (stat.size > BigInt(ANALYZE_LIMITS.fileBytes)) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Visible SVG exceeds ${ANALYZE_LIMITS.fileBytes} bytes.`, relativePath);
    }
    const size = Number(stat.size);
    if (state.visibleSvgBytes + size > ANALYZE_LIMITS.aggregateSvgBytes) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Directory snapshot exceeds ${ANALYZE_LIMITS.aggregateSvgBytes} visible SVG bytes.`);
    }
    state.visibleSvgBytes += size;
    state.candidates.set(relativePath, { sourcePath: relativePath, kind: "file" });
    state.candidateStats.set(relativePath, stat);
  } finally {
    addon.closeHandle(handle);
  }
}

function walkNativeTree(
  addon: DirectorySnapshotNativeAddon,
  handle: NativeHandle,
  relativePath: string,
  collectionPath: string,
  collection: SourceMapCollectionV1,
  ctx: DiagnosticContext,
  state: NativeScanState,
): void {
  if (excludedBy(collection, collectionPath)) return;
  const visitKey = `${collection.id}\0${relativePath}`;
  if (state.visitedDirectories.has(visitKey)) return;
  state.visitedDirectories.add(visitKey);
  const before = addon.statHandle(handle);
  if (before.type !== "directory") fail(ctx, "DIRECTORY_NOT_DIRECTORY", "Traversed source must remain a directory.", relativePath);
  const entries = nativeEntries(addon, handle, relativePath, ctx, state);
  const children: DirectoryChildDto[] = [];
  for (const entry of entries) {
    const childPath = joined(relativePath, entry.name);
    const childCollectionPath = joined(collectionPath, entry.name);
    validatePortablePathValue(childPath, ctx, childPath, { allowDot: true });
    if (excludedBy(collection, childCollectionPath)) continue;
    if (entry.kind === "symlink") fail(ctx, "DIRECTORY_TRAVERSED_SYMLINK", "Traversed collection contains a symlink.", childPath);
    if (entry.kind === "special") fail(ctx, "DIRECTORY_SPECIAL_FILE", "Traversed collection contains a special file.", childPath);
    children.push({ name: entry.name, kind: entry.kind });
    if (entry.kind === "directory") {
      const child = addon.openChildDirectory(handle, entry.name);
      try {
        if (!sameNativeStat(entry.stat, addon.statHandle(child))) {
          fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory entry changed before authenticated open.", childPath);
        }
        walkNativeTree(addon, child, childPath, childCollectionPath, collection, ctx, state);
      }
      finally { addon.closeHandle(child); }
    } else {
      inspectNativeCandidate(addon, handle, entry.name, childPath, entry.stat, ctx, state);
    }
  }
  const after = addon.statHandle(handle);
  if (!sameNativeStat(before, after)) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory source changed during authenticated traversal.", relativePath);
  recordNativeDirectory(state, relativePath, after, entries, children, ctx);
}

function inspectNativeExactPath(
  addon: DirectorySnapshotNativeAddon,
  sourceRoot: NativeHandle,
  relativePath: string,
  ctx: DiagnosticContext,
  state: NativeScanState,
): void {
  const parts = relativePath.split("/");
  const parentPaths: string[] = [];
  if (parts.length === 1) parentPaths.push(".");
  else {
    for (let index = 0; index < parts.length - 1; index += 1) parentPaths.push(parts.slice(0, index + 1).join("/"));
  }
  for (const parentPath of parentPaths) {
    if (state.visitedDirectories.has(parentPath)) continue;
    state.visitedDirectories.add(parentPath);
    const opened = openDirectoryFromSource(addon, sourceRoot, parentPath, ctx);
    try {
      const before = addon.statHandle(opened.handle);
      const entries = nativeEntries(addon, opened.handle, parentPath, ctx, state);
      const children: DirectoryChildDto[] = entries.map((entry) => {
        const childPath = joined(parentPath, entry.name);
        if (entry.kind === "symlink") fail(ctx, "DIRECTORY_TRAVERSED_SYMLINK", "Traversed collection contains a symlink.", childPath);
        if (entry.kind === "special") fail(ctx, "DIRECTORY_SPECIAL_FILE", "Traversed collection contains a special file.", childPath);
        return { name: entry.name, kind: entry.kind };
      });
      const after = addon.statHandle(opened.handle);
      if (!sameNativeStat(before, after)) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory source changed during authenticated traversal.", parentPath);
      recordNativeDirectory(state, parentPath, after, entries, children, ctx);
    } finally {
      closeNativeHandles(addon, opened.opened);
    }
  }
  validatePortablePathValue(relativePath, ctx, relativePath);
  const parentPath = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
  const name = parts.at(-1)!;
  const opened = openDirectoryFromSource(addon, sourceRoot, parentPath, ctx);
  try {
    const entry = addon.readDirectory(opened.handle).find((candidate) => candidate.name === name);
    if (entry === undefined) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected source disappeared during authenticated traversal.", relativePath);
    inspectNativeCandidate(addon, opened.handle, name, relativePath, entry.stat, ctx, state);
  }
  finally { closeNativeHandles(addon, opened.opened); }
}

function inspectNativeOptionalPath(
  addon: DirectorySnapshotNativeAddon,
  sourceRoot: NativeHandle,
  relativePath: string,
  ctx: DiagnosticContext,
  state: NativeScanState,
): boolean {
  const parts = relativePath.split("/");
  const parentPaths: string[] = [];
  if (parts.length === 1) parentPaths.push(".");
  else for (let index = 0; index < parts.length - 1; index += 1) parentPaths.push(parts.slice(0, index + 1).join("/"));
  for (const parentPath of parentPaths) {
    if (state.visitedDirectories.has(parentPath)) continue;
    state.visitedDirectories.add(parentPath);
    const opened = openDirectoryFromSource(addon, sourceRoot, parentPath, ctx);
    try {
      const before = addon.statHandle(opened.handle);
      const entries = nativeEntries(addon, opened.handle, parentPath, ctx, state);
      const children: DirectoryChildDto[] = entries.map((entry) => {
        const childPath = joined(parentPath, entry.name);
        if (entry.kind === "symlink") fail(ctx, "DIRECTORY_TRAVERSED_SYMLINK", "Traversed collection contains a symlink.", childPath);
        if (entry.kind === "special") fail(ctx, "DIRECTORY_SPECIAL_FILE", "Traversed collection contains a special file.", childPath);
        return { name: entry.name, kind: entry.kind };
      });
      const after = addon.statHandle(opened.handle);
      if (!sameNativeStat(before, after)) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory source changed during authenticated traversal.", parentPath);
      recordNativeDirectory(state, parentPath, after, entries, children, ctx);
    } finally {
      closeNativeHandles(addon, opened.opened);
    }
  }
  validatePortablePathValue(relativePath, ctx, relativePath);
  const parentPath = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
  const opened = openDirectoryFromSource(addon, sourceRoot, parentPath, ctx);
  try {
    return addon.readDirectory(opened.handle).some((candidate) => candidate.name === parts.at(-1)!);
  } finally {
    closeNativeHandles(addon, opened.opened);
  }
}

function openSelectedNativeFile(
  addon: DirectorySnapshotNativeAddon,
  sourceRoot: NativeHandle,
  identity: SourceIdentity,
  candidateStat: NativeStat,
  ctx: DiagnosticContext,
): NativeFileRecord {
  const parts = identity.sourcePath.split("/");
  const parentPath = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
  const name = parts.at(-1)!;
  const opened = openDirectoryFromSource(addon, sourceRoot, parentPath, ctx);
  let file: NativeHandle | undefined;
  try {
    file = addon.openChildRegular(opened.handle, name);
    const before = addon.statHandle(file);
    if (!sameNativeStat(candidateStat, before)) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected source changed before authenticated read.", identity.sourcePath);
    if (before.linkCount > 1n) fail(ctx, "DIRECTORY_HARD_LINK", "Selected source must not be hard linked.", identity.sourcePath);
    if (before.size > BigInt(ARCHIVE_LIMITS.selectedEntryBytes)) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Selected SVG exceeds ${ARCHIVE_LIMITS.selectedEntryBytes} bytes.`, identity.sourcePath);
    }
    const bytes = addon.readRegular(file, ARCHIVE_LIMITS.selectedEntryBytes);
    const after = addon.statHandle(file);
    if (BigInt(bytes.byteLength) !== before.size || !sameNativeStat(before, after)) {
      fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected source changed during authenticated read.", identity.sourcePath);
    }
    const dto: DirectoryFileDto = {
      ...identity,
      kind: "file",
      byteCount: bytes.byteLength,
      sourceBasis: DIRECTORY_FILE_BYTES_BASIS,
      sourceDigest: computeSha256(Buffer.concat([Buffer.from(`${DIRECTORY_FILE_BYTES_BASIS}\n`, "utf8"), bytes])),
    };
    return { dto, stat: after, bytes, handle: file };
  } catch (error) {
    if (file !== undefined) addon.closeHandle(file);
    throw error;
  } finally {
    closeNativeHandles(addon, opened.opened);
  }
}

function openSelectedNativeCompanion(
  addon: DirectorySnapshotNativeAddon,
  sourceRoot: NativeHandle,
  companion: { readonly collectionId: string; readonly sourcePath: string },
  ctx: DiagnosticContext,
): NativeFileRecord {
  validatePortablePathValue(companion.sourcePath, ctx, companion.sourcePath);
  const parts = companion.sourcePath.split("/");
  const parentPath = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
  const name = parts.at(-1)!;
  const opened = openDirectoryFromSource(addon, sourceRoot, parentPath, ctx);
  let file: NativeHandle | undefined;
  try {
    const entry = addon.readDirectory(opened.handle).find((candidate) => candidate.name === name);
    if (entry === undefined) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected companion disappeared during authenticated traversal.", companion.sourcePath);
    if (entry.kind === "symlink") fail(ctx, "DIRECTORY_TRAVERSED_SYMLINK", "Selected companion must not be a symlink.", companion.sourcePath);
    if (entry.kind !== "file") fail(ctx, "DIRECTORY_SPECIAL_FILE", "Selected companion must be a regular file.", companion.sourcePath);
    file = addon.openChildRegular(opened.handle, name);
    const before = addon.statHandle(file);
    if (!sameNativeStat(entry.stat, before)) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected companion changed before authenticated read.", companion.sourcePath);
    if (before.linkCount > 1n) fail(ctx, "DIRECTORY_HARD_LINK", "Selected companion must not be hard linked.", companion.sourcePath);
    if (before.size > BigInt(ARCHIVE_LIMITS.selectedEntryBytes)) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Selected companion exceeds ${ARCHIVE_LIMITS.selectedEntryBytes} bytes.`, companion.sourcePath);
    const bytes = addon.readRegular(file, ARCHIVE_LIMITS.selectedEntryBytes);
    const after = addon.statHandle(file);
    if (BigInt(bytes.byteLength) !== before.size || !sameNativeStat(before, after)) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected companion changed during authenticated read.", companion.sourcePath);
    const dto: DirectoryCompanionDto = {
      ...companion,
      kind: "file",
      byteCount: bytes.byteLength,
      sourceBasis: DIRECTORY_FILE_BYTES_BASIS,
      sourceDigest: computeSha256(Buffer.concat([Buffer.from(`${DIRECTORY_FILE_BYTES_BASIS}\n`, "utf8"), bytes])),
    };
    return { dto, stat: after, bytes, handle: file };
  } catch (error) {
    if (file !== undefined) addon.closeHandle(file);
    throw error;
  } finally {
    closeNativeHandles(addon, opened.opened);
  }
}

async function readSelectedFile(root: string, identity: SourceIdentity, ctx: DiagnosticContext): Promise<DirectoryFileDto> {
  const absolutePath = resolve(root, identity.sourcePath);
  const before = await lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) fail(ctx, "DIRECTORY_UNSAFE_FILE", "Selected source must remain a regular file.", identity.sourcePath);
  if (before.nlink > 1) fail(ctx, "DIRECTORY_HARD_LINK", "Selected source must not be hard linked.", identity.sourcePath);
  if (before.size > ARCHIVE_LIMITS.selectedEntryBytes) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Selected SVG exceeds ${ARCHIVE_LIMITS.selectedEntryBytes} bytes.`, identity.sourcePath);
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || !sameIdentity(before, openedBefore)) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected source changed before read.", identity.sourcePath);
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    const after = await lstat(absolutePath);
    if (bytes.byteLength !== before.size || !sameIdentity(openedBefore, openedAfter) || !sameIdentity(openedAfter, after)) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected source changed during read.", identity.sourcePath);
    return { ...identity, kind: "file", byteCount: bytes.byteLength, sourceBasis: DIRECTORY_FILE_BYTES_BASIS, sourceDigest: computeSha256(Buffer.concat([Buffer.from(`${DIRECTORY_FILE_BYTES_BASIS}\n`, "utf8"), bytes])) };
  } finally { await handle.close(); }
}

function canonicalLines(directories: readonly DirectoryInventoryDto[], files: readonly (DirectoryFileDto | DirectoryCompanionDto)[]): readonly string[] {
  const records = [
    ...directories.map((directory) => ({ path: directory.path, line: JSON.stringify({ kind: directory.kind, path: directory.path, children: directory.children.map((child) => [child.name, child.kind]) }) })),
    ...files.map((file) => ({ path: file.sourcePath, line: JSON.stringify({ kind: file.kind, path: file.sourcePath, bytes: file.byteCount, sourceBasis: file.sourceBasis, sourceDigest: file.sourceDigest }) })),
  ];
  records.sort((left, right) => compareUtf8(left.path, right.path) || compareUtf8(left.line, right.line));
  return records.map((record) => record.line);
}

export function computeDirectorySnapshotDigest(sourceMapDigest: Sha256Digest, directories: readonly DirectoryInventoryDto[], files: readonly (DirectoryFileDto | DirectoryCompanionDto)[]): Sha256Digest {
  const body = canonicalLines(directories, files).map((line) => `${line}\n`).join("");
  return computeSha256(Buffer.from(`${DIRECTORY_SNAPSHOT_BASIS}\n${sourceMapDigest}\n${body}`, "utf8"));
}

export function getDirectorySnapshotCapability(root = "/"): DirectorySnapshotCapability {
  const loaded = loadDirectorySnapshotNative();
  if (!loaded.ok) {
    return {
      supported: false,
      code: DIRECTORY_SNAPSHOT_UNSUPPORTED,
      backend: "none",
      missingPrimitive: "handle-relative-openat-equivalent",
      platformArtifact: loaded.artifact,
      filesystemClass: "unsupported",
    };
  }
  const ctx = context();
  let ancestry: readonly NativeHandle[] = [];
  try {
    ancestry = openSourceAncestry(loaded.addon, splitSourceRoot(root, ctx));
    const sourceRoot = ancestry.at(-1)!;
    const stat = loaded.addon.statHandle(sourceRoot);
    const filesystem = loaded.addon.statFilesystem(sourceRoot);
    if (stat.type !== "directory" || filesystem.category !== "qualified-local") {
      return {
        supported: false,
        code: DIRECTORY_SNAPSHOT_UNSUPPORTED,
        backend: "none",
        missingPrimitive: "handle-relative-openat-equivalent",
        platformArtifact: loaded.artifact,
        filesystemClass: "unsupported",
      };
    }
    return {
      supported: true,
      backend: DIRECTORY_SNAPSHOT_BACKEND,
      platformArtifact: loaded.artifact,
      filesystemClass: "qualified-local",
    };
  } catch {
    return {
      supported: false,
      code: DIRECTORY_SNAPSHOT_UNSUPPORTED,
      backend: "none",
      missingPrimitive: "handle-relative-openat-equivalent",
      platformArtifact: loaded.artifact,
      filesystemClass: "unsupported",
    };
  } finally {
    closeNativeHandles(loaded.addon, ancestry);
  }
}

export async function qualifyDirectorySnapshotPlatform(root: string): Promise<Result<DirectorySnapshotQualification>> {
  const ctx = context();
  try {
    splitSourceRoot(root, ctx);
    const capability = getDirectorySnapshotCapability(root);
    return ok({
      ...capability,
      rootHandleOpened: capability.supported,
      handleRelativeDirectoryOpen: capability.supported,
      handleRelativeFileOpen: capability.supported,
      handleRelativeStat: capability.supported,
      noFollowLeafOpen: capability.supported,
      descriptorIdentityCheck: capability.supported,
    });
  } catch (error) {
    return fromCaught(error, ctx, "DIRECTORY_QUALIFICATION_FAILED", "Directory snapshot platform qualification failed.", (caught) => caught instanceof DiagnosticError || (caught instanceof Error && "code" in caught));
  }
}

export async function createDirectorySnapshot(root: string, map: SourceMapV1, collectionIds?: readonly string[], options: DirectorySnapshotSelectionOptions = {}): Promise<Result<AuthenticatedDirectorySnapshot>> {
  const ctx = context();
  const loaded = loadDirectorySnapshotNative();
  if (!loaded.ok) {
    return { ok: false, diagnostics: [diagnostic(ctx, DIRECTORY_SNAPSHOT_UNSUPPORTED, "Mutation-grade directory snapshot backend is unavailable.")] };
  }
  let ancestry: readonly NativeHandle[] = [];
  const fileRecords: NativeFileRecord[] = [];
  let transferred = false;
  try {
    const sourceComponents = splitSourceRoot(root, ctx);
    ancestry = openSourceAncestry(loaded.addon, sourceComponents);
    const sourceRoot = ancestry.at(-1)!;
    const sourceRootStat = loaded.addon.statHandle(sourceRoot);
    if (sourceRootStat.type !== "directory") fail(ctx, "DIRECTORY_UNSAFE_ROOT", "Directory source root must be a directory.");
    const filesystem = loaded.addon.statFilesystem(sourceRoot);
    if (filesystem.category !== "qualified-local") {
      fail(ctx, DIRECTORY_SNAPSHOT_UNSUPPORTED, "Directory snapshot filesystem class is unsupported.");
    }
    const collections = selectedCollections(map, collectionIds, ctx);
    const boundedMap: SourceMapV1 = { ...map, collections };
    const state: NativeScanState = {
      entries: 0,
      visibleSvgBytes: 0,
      countedEntries: new Set(),
      visitedDirectories: new Set(),
      directories: new Map(),
      candidates: new Map(),
      candidateStats: new Map(),
      nativeDirectories: new Map(),
    };
    for (const collection of collections) {
      for (const tree of collection.includeTrees) {
        if (excludedBy(collection, tree)) continue;
        const relativePath = collection.root === "." ? tree : joined(collection.root, tree);
        const opened = openDirectoryFromSource(loaded.addon, sourceRoot, relativePath, ctx);
        try { walkNativeTree(loaded.addon, opened.handle, relativePath, tree, collection, ctx, state); }
        finally { closeNativeHandles(loaded.addon, opened.opened); }
      }
      for (const path of collection.includePaths) {
        if (!excludedBy(collection, path)) {
          inspectNativeExactPath(loaded.addon, sourceRoot, collection.root === "." ? path : joined(collection.root, path), ctx, state);
        }
      }
    }
    const selection = evaluateSourceMapSelection(boundedMap, [...state.candidates.values()]);
    if (!selection.ok) throw new DiagnosticError(selection.diagnostics[0]!);
    let selected = selection.value;
    if (options.selectedPaths !== undefined && options.selectedPaths.length > 0) {
      const exact = new Set<string>();
      const portable = new Set<string>();
      for (const sourcePath of options.selectedPaths) {
        validatePortablePathValue(sourcePath, ctx, sourcePath);
        const key = portablePathKey(sourcePath);
        if (exact.has(sourcePath) || portable.has(key)) fail(ctx, "DIRECTORY_DUPLICATE_SELECTION", "Directory selection contains a duplicate source path.", sourcePath);
        exact.add(sourcePath);
        portable.add(key);
      }
      const byPath = new Map(selection.value.map((item) => [item.sourcePath, item]));
      selected = options.selectedPaths.map((sourcePath) => {
        const item = byPath.get(sourcePath);
        if (item === undefined) fail(ctx, state.candidates.has(sourcePath) ? "DIRECTORY_PATH_OUTSIDE_COLLECTION" : "DIRECTORY_UNKNOWN_SELECTION", "Selected path is not an included SVG owned by the named collections.", sourcePath);
        return item;
      }).sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath));
    }
    if (selected.length > ARCHIVE_LIMITS.selectedSvgEntries) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Directory selection supports at most ${ARCHIVE_LIMITS.selectedSvgEntries} SVG files.`);
    }
    const identities = deriveSourceMapIdentities(boundedMap, selected);
    if (!identities.ok) throw new DiagnosticError(identities.diagnostics[0]!);
    let aggregateBytes = 0;
    for (const identity of identities.value) {
      const candidateStat = state.candidateStats.get(identity.sourcePath);
      if (candidateStat === undefined) fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected source disappeared during authenticated traversal.", identity.sourcePath);
      const record = openSelectedNativeFile(loaded.addon, sourceRoot, identity, candidateStat, ctx);
      fileRecords.push(record);
      aggregateBytes += record.dto.byteCount;
      if (aggregateBytes > ARCHIVE_LIMITS.selectedAggregateBytes) {
        fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Directory selection exceeds ${ARCHIVE_LIMITS.selectedAggregateBytes} aggregate bytes.`);
      }
    }
    const companionKeys = new Set<string>();
    const requestedCompanions = [
      ...(options.companions ?? []).map((companion) => ({ companion, optional: false })),
      ...(options.optionalCompanions ?? []).map((companion) => ({ companion, optional: true })),
    ];
    for (const { companion, optional } of requestedCompanions) {
      validatePortablePathValue(companion.sourcePath, ctx, companion.sourcePath);
      const owner = collections.find((collection) => collection.id === companion.collectionId);
      if (owner === undefined || owner.root !== "." && !companion.sourcePath.startsWith(`${owner.root}/`)) fail(ctx, "DIRECTORY_COMPANION_OUTSIDE_COLLECTION", "Companion path must be rooted in its selected collection.", companion.sourcePath);
      const key = portablePathKey(companion.sourcePath);
      if (companionKeys.has(key)) fail(ctx, "DIRECTORY_DUPLICATE_COMPANION", "Directory companion selection contains a duplicate path.", companion.sourcePath);
      companionKeys.add(key);
      if (companion.sourcePath.toLowerCase().endsWith(".svg")) fail(ctx, "DIRECTORY_COMPANION_SVG", "An SVG source must be selected as an asset, not a companion.", companion.sourcePath);
      const present = inspectNativeOptionalPath(loaded.addon, sourceRoot, companion.sourcePath, ctx, state);
      if (!present) {
        if (optional) continue;
        fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected companion disappeared during authenticated traversal.", companion.sourcePath);
      }
      fileRecords.push(openSelectedNativeCompanion(loaded.addon, sourceRoot, companion, ctx));
    }
    fileRecords.sort((left, right) => compareUtf8(left.dto.sourcePath, right.dto.sourcePath));
    const files = fileRecords.filter((record): record is NativeFileRecord & { readonly dto: DirectoryFileDto } => "assetId" in record.dto).map((record) => Object.freeze(record.dto));
    const companions = fileRecords.filter((record): record is NativeFileRecord & { readonly dto: DirectoryCompanionDto } => !("assetId" in record.dto)).map((record) => Object.freeze(record.dto));
    const directories = [...state.directories.values()]
      .sort((left, right) => compareUtf8(left.path, right.path))
      .map((directory) => Object.freeze({
        ...directory,
        children: Object.freeze(directory.children.map((child) => Object.freeze({ ...child }))),
      }));
    const sourceMapDigest = computeSourceMapDigest(map);
    const snapshot: AuthenticatedDirectorySnapshot = Object.freeze({
      authenticated: true,
      backend: DIRECTORY_SNAPSHOT_BACKEND,
      platformArtifact: loaded.artifact,
      filesystemClass: "qualified-local",
      sourceMapDigest,
      inventoryDigest: computeDirectorySnapshotDigest(sourceMapDigest, directories, [...files, ...companions]),
      directories: Object.freeze(directories),
      files: Object.freeze(files),
      companions: Object.freeze(companions),
      diagnostics: Object.freeze([]),
    });
    const session: NativeSnapshotSession = {
      addon: loaded.addon,
      artifact: loaded.artifact,
      sourceComponents,
      ancestry,
      sourceRoot,
      sourceRootStat,
      directoryRecords: [...state.nativeDirectories.values()].sort((left, right) => compareUtf8(left.path, right.path)),
      fileRecords,
      closed: false,
    };
    nativeSessions.set(snapshot, session);
    transferred = true;
    return ok(snapshot);
  } catch (error) {
    return fromNativeCaught(error, ctx, "DIRECTORY_SNAPSHOT_FAILED", "Authenticated directory snapshot failed.");
  } finally {
    if (!transferred) {
      closeNativeHandles(loaded.addon, fileRecords.map((record) => record.handle));
      closeNativeHandles(loaded.addon, ancestry);
      for (const record of fileRecords) record.bytes.fill(0);
    }
  }
}

/** Internal authenticated byte-copy seam for directory import. Not re-exported by the package root. */
export function copyDirectorySnapshotFileBytes(snapshot: AuthenticatedDirectorySnapshot, sourcePath: string): Uint8Array {
  const session = nativeSessions.get(snapshot);
  if (session === undefined || session.closed) fail(context(), "DIRECTORY_SNAPSHOT_CLOSED", "Authenticated directory snapshot is closed.", sourcePath);
  const record = session.fileRecords.find((candidate) => candidate.dto.sourcePath === sourcePath);
  if (record === undefined) fail(context(), "DIRECTORY_SOURCE_NOT_AUTHENTICATED", "Source path is not part of the authenticated directory snapshot.", sourcePath);
  return Buffer.from(record.bytes);
}

/**
 * Internal retention seam for plans that retain an authenticated snapshot.
 * The native session is reachable only through its private WeakMap entry; a
 * public snapshot DTO by itself does not account for retained source buffers.
 */
export function inspectDirectorySnapshotRetention(snapshot: AuthenticatedDirectorySnapshot): PlanRetentionInspection {
  const session = nativeSessions.get(snapshot);
  if (session === undefined) throw new Error("Directory snapshot was not produced by this snapshot backend.");
  if (session.closed) return inspectPlanRetention([snapshot]);
  return inspectPlanRetention([snapshot, session], "directory");
}

/** Internal handle-relative read for semantic authority files such as the canonical source map. */
export function readDirectorySnapshotAuthorityFile(snapshot: AuthenticatedDirectorySnapshot, sourcePath: string, maxBytes: number): Uint8Array {
  const session = nativeSessions.get(snapshot);
  if (session === undefined || session.closed) fail(context(), "DIRECTORY_SNAPSHOT_CLOSED", "Authenticated directory snapshot is closed.", sourcePath);
  validatePortablePathValue(sourcePath, context(), sourcePath);
  const parts = sourcePath.split("/");
  const parentPath = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
  const opened = openDirectoryFromSource(session.addon, session.sourceRoot, parentPath, context());
  let file: NativeHandle | undefined;
  try {
    file = session.addon.openChildRegular(opened.handle, parts.at(-1)!);
    const before = session.addon.statHandle(file);
    if (before.type !== "file" || before.linkCount > 1n || before.size > BigInt(maxBytes)) fail(context(), "DIRECTORY_UNSAFE_FILE", "Authority file must be a bounded regular non-hard-linked file.", sourcePath);
    const bytes = session.addon.readRegular(file, maxBytes);
    const after = session.addon.statHandle(file);
    if (!sameNativeStat(before, after) || BigInt(bytes.byteLength) !== before.size) fail(context(), "DIRECTORY_SOURCE_CHANGED", "Authority file changed during authenticated read.", sourcePath);
    return Buffer.from(bytes);
  } finally {
    if (file !== undefined) session.addon.closeHandle(file);
    closeNativeHandles(session.addon, opened.opened);
  }
}

export function closeDirectorySnapshot(snapshot: AuthenticatedDirectorySnapshot): void {
  const session = nativeSessions.get(snapshot);
  if (session === undefined || session.closed) return;
  session.closed = true;
  closeNativeHandles(session.addon, session.fileRecords.map((record) => record.handle));
  closeNativeHandles(session.addon, session.ancestry);
  for (const record of session.fileRecords) record.bytes.fill(0);
}

export async function revalidateDirectorySnapshot(
  snapshot: AuthenticatedDirectorySnapshot,
  map: SourceMapV1,
): Promise<Result<AuthenticatedDirectoryRevalidationResult>> {
  const ctx = context();
  const session = nativeSessions.get(snapshot);
  if (session === undefined || session.closed) {
    return { ok: false, diagnostics: [diagnostic(ctx, "DIRECTORY_SNAPSHOT_CLOSED", "Authenticated directory snapshot is closed.")] };
  }
  try {
    if (computeSourceMapDigest(map) !== snapshot.sourceMapDigest) {
      fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory source map changed after authenticated snapshot.");
    }
    const namedAncestry = openSourceAncestry(session.addon, session.sourceComponents);
    try {
      const namedRoot = namedAncestry.at(-1)!;
      if (!sameNativeIdentity(session.sourceRootStat, session.addon.statHandle(namedRoot))) {
        fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Named directory source root changed after authenticated snapshot.");
      }
      if (session.addon.statFilesystem(namedRoot).category !== "qualified-local") {
        fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory source filesystem changed after authenticated snapshot.");
      }
    } finally {
      closeNativeHandles(session.addon, namedAncestry);
    }
    for (const record of session.directoryRecords) {
      const opened = openDirectoryFromSource(session.addon, session.sourceRoot, record.path, ctx);
      try {
        const before = session.addon.statHandle(opened.handle);
        const entries = [...session.addon.readDirectory(opened.handle)].sort((left, right) => compareUtf8(left.name, right.name));
        const after = session.addon.statHandle(opened.handle);
        if (!sameNativeStat(record.stat, before) || !sameNativeStat(before, after) || !sameNativeEntries(record.children, entries)) {
          fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory inventory changed after authenticated snapshot.", record.path);
        }
      } finally {
        closeNativeHandles(session.addon, opened.opened);
      }
    }
    for (const record of session.fileRecords) {
      const parts = record.dto.sourcePath.split("/");
      const parentPath = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
      const opened = openDirectoryFromSource(session.addon, session.sourceRoot, parentPath, ctx);
      let file: NativeHandle | undefined;
      try {
        file = session.addon.openChildRegular(opened.handle, parts.at(-1)!);
        const before = session.addon.statHandle(file);
        if (!sameNativeStat(record.stat, before) || before.linkCount > 1n) {
          fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected source identity changed after authenticated snapshot.", record.dto.sourcePath);
        }
        const bytes = session.addon.readRegular(file, ARCHIVE_LIMITS.selectedEntryBytes);
        const after = session.addon.statHandle(file);
        const digest = computeSha256(Buffer.concat([Buffer.from(`${DIRECTORY_FILE_BYTES_BASIS}\n`, "utf8"), bytes]));
        if (!sameNativeStat(before, after) || !bytes.equals(record.bytes) || digest !== record.dto.sourceDigest) {
          fail(ctx, "DIRECTORY_SOURCE_CHANGED", "Selected source bytes changed after authenticated snapshot.", record.dto.sourcePath);
        }
      } finally {
        if (file !== undefined) session.addon.closeHandle(file);
        closeNativeHandles(session.addon, opened.opened);
      }
    }
    return ok({ authenticated: true, portableContentUnchanged: true, inventoryDigest: snapshot.inventoryDigest });
  } catch (error) {
    return fromNativeCaught(error, ctx, "DIRECTORY_SOURCE_CHANGED", "Directory source changed after authenticated snapshot.");
  }
}

export async function discoverDirectorySources(root: string, map: SourceMapV1, collectionIds?: readonly string[], options: DirectoryDiscoveryOptions = {}): Promise<Result<DirectoryDiscoveryResult>> {
  const ctx = context();
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(ctx, "DIRECTORY_UNSAFE_ROOT", "Directory source root must be a real directory.");
    const collections = selectedCollections(map, collectionIds, ctx);
    const boundedMap: SourceMapV1 = { ...map, collections };
    const state: ScanState = {
      entries: 0,
      visibleSvgBytes: 0,
      countedEntries: new Set(),
      visitedDirectories: new Set(),
      directories: new Map(),
      candidates: new Map(),
    };
    for (const collection of collections) {
      const collectionRoot = collection.root;
      for (const tree of collection.includeTrees) {
        if (!excludedBy(collection, tree)) {
          await walkTree(root, collectionRoot === "." ? tree : joined(collectionRoot, tree), tree, collection, ctx, state);
        }
      }
      for (const path of collection.includePaths) {
        if (!excludedBy(collection, path)) {
          await inspectExactPath(root, collectionRoot === "." ? path : joined(collectionRoot, path), ctx, state);
        }
      }
    }
    const selection = evaluateSourceMapSelection(boundedMap, [...state.candidates.values()]);
    if (!selection.ok) throw new DiagnosticError(selection.diagnostics[0]!);
    let selected = selection.value;
    if (options.selectedPaths !== undefined && options.selectedPaths.length > 0) {
      const exact = new Set<string>();
      const portable = new Set<string>();
      for (const sourcePath of options.selectedPaths) {
        validatePortablePathValue(sourcePath, ctx, sourcePath);
        const key = portablePathKey(sourcePath);
        if (exact.has(sourcePath) || portable.has(key)) fail(ctx, "DIRECTORY_DUPLICATE_SELECTION", "Directory selection contains a duplicate source path.", sourcePath);
        exact.add(sourcePath);
        portable.add(key);
      }
      const byPath = new Map(selection.value.map((item) => [item.sourcePath, item]));
      selected = options.selectedPaths.map((sourcePath) => {
        const item = byPath.get(sourcePath);
        if (item === undefined) fail(ctx, state.candidates.has(sourcePath) ? "DIRECTORY_PATH_OUTSIDE_COLLECTION" : "DIRECTORY_UNKNOWN_SELECTION", "Selected path is not an included SVG owned by the named collections.", sourcePath);
        return item;
      }).sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath));
    }
    if (selected.length > ARCHIVE_LIMITS.selectedSvgEntries) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Directory selection supports at most ${ARCHIVE_LIMITS.selectedSvgEntries} SVG files.`);
    const identities = deriveSourceMapIdentities(boundedMap, selected);
    if (!identities.ok) throw new DiagnosticError(identities.diagnostics[0]!);
    const sizes: Stats[] = [];
    for (const identity of identities.value) sizes.push(await lstat(resolve(root, identity.sourcePath)));
    const selectedBytes = sizes.reduce((total, stat) => total + stat.size, 0);
    if (selectedBytes > ARCHIVE_LIMITS.selectedAggregateBytes) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Directory selection exceeds ${ARCHIVE_LIMITS.selectedAggregateBytes} aggregate bytes.`);
    const files: DirectoryFileDto[] = [];
    for (const identity of identities.value) files.push(await readSelectedFile(root, identity, ctx));
    files.sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath));
    const directories = [...state.directories.values()].sort((left, right) => compareUtf8(left.path, right.path));
    const sourceMapDigest = computeSourceMapDigest(map);
    return ok({ authenticated: false, sourceMapDigest, inventoryDigest: computeDirectorySnapshotDigest(sourceMapDigest, directories, files), directories, files, diagnostics: [] });
  } catch (error) {
    return fromCaught(error, ctx, "DIRECTORY_DISCOVERY_FAILED", "Directory discovery failed.", (caught) => caught instanceof DiagnosticError || (caught instanceof Error && "code" in caught));
  }
}

export async function revalidateDirectoryDiscovery(root: string, map: SourceMapV1, previous: DirectoryDiscoveryResult, collectionIds?: readonly string[]): Promise<Result<DirectoryRevalidationResult>> {
  const ctx = context();
  const current = await discoverDirectorySources(root, map, collectionIds, { selectedPaths: previous.files.map((file) => file.sourcePath) });
  if (!current.ok) {
    if (current.diagnostics[0]?.code === "DIRECTORY_UNKNOWN_SELECTION") {
      return { ok: false, diagnostics: [diagnostic(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory source changed after discovery.")] };
    }
    return current;
  }
  if (current.value.sourceMapDigest !== previous.sourceMapDigest || current.value.inventoryDigest !== previous.inventoryDigest) {
    return { ok: false, diagnostics: [diagnostic(ctx, "DIRECTORY_SOURCE_CHANGED", "Directory source changed after discovery.")] };
  }
  return ok({ authenticated: false, portableContentUnchanged: true, inventoryDigest: current.value.inventoryDigest });
}
