import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DIRECTORY_SNAPSHOT_BACKEND = "native-addon-posix-openat-v1" as const;
export const DIRECTORY_SNAPSHOT_BACKEND_ABI = 1 as const;

export type DirectorySnapshotPlatformArtifact = "darwin-arm64" | "darwin-x64" | "linux-x64-gnu";
export type NativeFilesystemClass = "apfs" | "ext4" | "unsupported";
export type NativeFilesystemCategory = "qualified-local" | "unsupported";
export type NativeEntryKind = "directory" | "file" | "symlink" | "special";
export type NativeHandle = object;

export interface NativeStat {
  readonly type: NativeEntryKind;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: number;
  readonly linkCount: bigint;
  readonly size: bigint;
  readonly mtimeSeconds: bigint;
  readonly mtimeNanoseconds: number;
  readonly ctimeSeconds: bigint;
  readonly ctimeNanoseconds: number;
  readonly generation?: bigint;
}

export interface NativeFilesystemStat {
  readonly class: NativeFilesystemClass;
  readonly category: NativeFilesystemCategory;
}

export interface NativeDirectoryEntry {
  readonly name: string;
  readonly kind: NativeEntryKind;
  readonly stat: NativeStat;
}

export interface DirectorySnapshotNativeAddon {
  readonly backend: typeof DIRECTORY_SNAPSHOT_BACKEND;
  readonly abiVersion: typeof DIRECTORY_SNAPSHOT_BACKEND_ABI;
  openFilesystemRoot(): NativeHandle;
  openChildDirectory(parent: NativeHandle, component: string): NativeHandle;
  openChildRegular(parent: NativeHandle, component: string): NativeHandle;
  readDirectory(directory: NativeHandle): readonly NativeDirectoryEntry[];
  statHandle(handle: NativeHandle): NativeStat;
  statFilesystem(handle: NativeHandle): NativeFilesystemStat;
  readRegular(file: NativeHandle, maximumBytes: number): Buffer;
  closeHandle(handle: NativeHandle): void;
}

export type NativeLoadFailure = "unsupported-platform" | "artifact-missing-or-corrupt" | "backend-mismatch" | "self-test-failed";

export type NativeLoadResult =
  | { readonly ok: true; readonly artifact: DirectorySnapshotPlatformArtifact; readonly addon: DirectorySnapshotNativeAddon }
  | { readonly ok: false; readonly artifact: DirectorySnapshotPlatformArtifact | "none"; readonly reason: NativeLoadFailure };

function isGlibcRuntime(): boolean {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
  return typeof report?.header?.glibcVersionRuntime === "string" && report.header.glibcVersionRuntime.length > 0;
}

export function currentDirectorySnapshotArtifact(): DirectorySnapshotPlatformArtifact | "none" {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "x64" && isGlibcRuntime()) return "linux-x64-gnu";
  return "none";
}

function looksLikeAddon(value: unknown): value is DirectorySnapshotNativeAddon {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.backend === DIRECTORY_SNAPSHOT_BACKEND
    && candidate.abiVersion === DIRECTORY_SNAPSHOT_BACKEND_ABI
    && [
      "openFilesystemRoot",
      "openChildDirectory",
      "openChildRegular",
      "readDirectory",
      "statHandle",
      "statFilesystem",
      "readRegular",
      "closeHandle",
    ].every((name) => typeof candidate[name] === "function");
}

function selfTest(addon: DirectorySnapshotNativeAddon): boolean {
  let root: NativeHandle | undefined;
  try {
    root = addon.openFilesystemRoot();
    const stat = addon.statHandle(root);
    if (stat.type !== "directory" || stat.device < 0n || stat.inode < 0n) return false;
    const filesystem = addon.statFilesystem(root);
    if (!(["apfs", "ext4", "unsupported"] as const).includes(filesystem.class)) return false;
    const entries = addon.readDirectory(root);
    if (!Array.isArray(entries)) return false;
    addon.closeHandle(root);
    addon.closeHandle(root);
    try {
      addon.statHandle(root);
      return false;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "DIRECTORY_USE_AFTER_CLOSE";
    }
  } catch {
    return false;
  } finally {
    if (root !== undefined) {
      try { addon.closeHandle(root); } catch { /* fail closed above */ }
    }
  }
}

let cached: NativeLoadResult | undefined;

export function loadDirectorySnapshotNative(): NativeLoadResult {
  if (cached !== undefined) return cached;
  const artifact = currentDirectorySnapshotArtifact();
  if (artifact === "none") {
    cached = { ok: false, artifact, reason: "unsupported-platform" };
    return cached;
  }
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const artifactPath = join(packageRoot, "native", "directory-snapshot", "prebuilds", artifact, `${DIRECTORY_SNAPSHOT_BACKEND}.node`);
  let loaded: unknown;
  try {
    loaded = createRequire(import.meta.url)(artifactPath);
  } catch {
    cached = { ok: false, artifact, reason: "artifact-missing-or-corrupt" };
    return cached;
  }
  if (!looksLikeAddon(loaded)) {
    cached = { ok: false, artifact, reason: "backend-mismatch" };
    return cached;
  }
  if (!selfTest(loaded)) {
    cached = { ok: false, artifact, reason: "self-test-failed" };
    return cached;
  }
  cached = { ok: true, artifact, addon: loaded };
  return cached;
}
