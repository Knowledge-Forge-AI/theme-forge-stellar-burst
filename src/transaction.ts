import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { dirname, join } from "node:path";

import { verifyArchiveSnapshot, type ArchiveSnapshot } from "./archive.js";
import { computeSha256, type Sha256Digest } from "./digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { readRegularFileSnapshot, sameFileIdentity, type FileIdentity } from "./filesystem.js";

export type CanonicalTree = ReadonlyMap<string, Uint8Array>;

export interface CanonicalFileSnapshot {
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface CanonicalSnapshot {
  readonly root: string;
  readonly rootDev: number;
  readonly rootIno: number;
  readonly canonicalPresent: boolean;
  readonly canonicalDev?: number;
  readonly canonicalIno?: number;
  readonly directories: readonly string[];
  readonly directoryIdentities: ReadonlyMap<string, FileIdentity>;
  readonly files: ReadonlyMap<string, CanonicalFileSnapshot>;
}

export interface TransactionHooks {
  readonly beforeStageCreate?: () => void | Promise<void>;
  readonly beforeStageWrite?: () => void | Promise<void>;
  readonly afterStageWrite?: () => void | Promise<void>;
  readonly beforeFirstRename?: () => void | Promise<void>;
  readonly beforePromotion?: () => void | Promise<void>;
  readonly beforePromotionParentSync?: () => void | Promise<void>;
  readonly beforeRollback?: () => void | Promise<void>;
  readonly beforeBackupCleanup?: () => void | Promise<void>;
}

export interface CanonicalTransactionOptions {
  readonly root: string;
  readonly nextFiles: CanonicalTree;
  readonly expectedSnapshot: CanonicalSnapshot;
  readonly archiveSnapshot?: ArchiveSnapshot;
  readonly hooks?: TransactionHooks;
  readonly operation?: "import" | "reconcile" | "fmt";
}

export async function withCanonicalMutationLock<T>(
  root: string,
  operation: DiagnosticContext["operation"],
  action: () => Promise<T>,
): Promise<T> {
  const ctx: DiagnosticContext = { operation, domain: "transaction" };
  const lock = join(root, ".tfsb.lock");
  let handle;
  let lockIdentity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    handle = await open(lock, "wx", 0o600);
    const stat = await handle.stat();
    lockIdentity = { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail(ctx, "ROOT_LOCKED", "Canonical mutation lock exists; inspect the active or stale .tfsb.lock before retrying.", ".tfsb.lock");
    }
    throw error;
  }
  let primary: unknown;
  try {
    return await action();
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    let cleanupFailed = false;
    await handle.close().catch(() => { cleanupFailed = true; });
    const current = await optionalLstat(lock).catch(() => undefined);
    if (current === undefined || current.isSymbolicLink() || current.dev !== lockIdentity?.dev || current.ino !== lockIdentity.ino) cleanupFailed = true;
    else await rm(lock).catch(() => { cleanupFailed = true; });
    if (cleanupFailed) {
      const suffix = primary instanceof DiagnosticError ? ` after ${primary.diagnostic.code}` : primary === undefined ? "" : " after an earlier failure";
      fail(ctx, "TFSB_LOCK_CLEANUP_FAILED", `Operation ended${suffix}, but .tfsb.lock cleanup failed; inspect it before retrying.`, ".tfsb.lock");
    }
  }
}

function context(operation: DiagnosticContext["operation"] = "reconcile"): DiagnosticContext {
  return { operation, domain: "transaction" };
}

async function optionalLstat(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

function supportedFile(path: string): boolean {
  return path === ".tfsb/project.toml" || path === ".tfsb/provenance.json" ||
    /^\.tfsb\/assets\/[a-z0-9]+(?:-[a-z0-9]+)*\.toml$/.test(path) ||
    /^\.tfsb\/companions\/[^/]+$/.test(path);
}

async function readDirectoryEntries(path: string): Promise<Dirent<string>[]> {
  return readdir(path, { withFileTypes: true });
}

function snapshotFile(bytes: Uint8Array, stat: FileIdentity): CanonicalFileSnapshot {
  return {
    bytes, digest: computeSha256(bytes), dev: stat.dev, ino: stat.ino, mode: stat.mode,
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
  };
}

function fileIdentity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

export async function findRecoveryResidue(root: string): Promise<readonly string[]> {
  const entries = await readDirectoryEntries(root);
  return entries
    .filter((entry) => entry.name.startsWith(".tfsb-stage-") || entry.name.startsWith(".tfsb-backup-"))
    .map((entry) => entry.name)
    .sort();
}

export async function snapshotCanonicalTree(
  rootInput: string,
  allowAbsent = false,
  operation: DiagnosticContext["operation"] = "reconcile",
): Promise<CanonicalSnapshot> {
  const ctx = context(operation);
  const root = await realpath(rootInput);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(ctx, "ROOT_INVALID", "Canonical transaction root must be a non-symlink directory.");
  }
  const canonical = join(root, ".tfsb");
  const canonicalStat = await optionalLstat(canonical);
  if (canonicalStat === undefined) {
    if (!allowAbsent) fail(ctx, "ROOT_NOT_FOUND", "Canonical .tfsb directory is missing.", ".tfsb");
    return { root, rootDev: rootStat.dev, rootIno: rootStat.ino, canonicalPresent: false, directories: [], directoryIdentities: new Map(), files: new Map() };
  }
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
    fail(ctx, "ROOT_SYMLINK_ESCAPE", "Canonical .tfsb must be a non-symlink directory.", ".tfsb");
  }
  const files = new Map<string, CanonicalFileSnapshot>();
  const directories: string[] = [".tfsb"];
  const directoryIdentities = new Map<string, FileIdentity>([[".tfsb", fileIdentity(canonicalStat)]]);
  const topEntries = await readDirectoryEntries(canonical);
  for (const entry of topEntries) {
    const relative = `.tfsb/${entry.name}`;
    if (entry.name === "assets" || entry.name === "companions") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported canonical entry '${relative}'.`, relative);
      }
      directories.push(relative);
      const childDirectoryBefore = await lstat(join(root, relative));
      directoryIdentities.set(relative, fileIdentity(childDirectoryBefore));
      for (const child of await readDirectoryEntries(join(root, relative))) {
        const childRelative = `${relative}/${child.name}`;
        if (!child.isFile() || child.isSymbolicLink() || !supportedFile(childRelative)) {
          fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported canonical entry '${childRelative}'.`, childRelative);
        }
        const full = join(root, childRelative);
        const file = await readRegularFileSnapshot(full, ctx, "PROJECT_UNSUPPORTED_SOURCE", `Canonical file '${childRelative}' changed or became unsafe during snapshot.`);
        files.set(childRelative, snapshotFile(file.bytes, file.snapshot));
      }
      const childDirectoryAfter = await lstat(join(root, relative));
      if (!childDirectoryAfter.isDirectory() || childDirectoryAfter.isSymbolicLink() || !sameFileIdentity(fileIdentity(childDirectoryBefore), fileIdentity(childDirectoryAfter))) {
        fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", `Canonical directory '${relative}' changed during snapshot.`, relative);
      }
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !supportedFile(relative)) {
      fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported canonical entry '${relative}'.`, relative);
    }
    const full = join(root, relative);
    const file = await readRegularFileSnapshot(full, ctx, "PROJECT_UNSUPPORTED_SOURCE", `Canonical file '${relative}' changed or became unsafe during snapshot.`);
    files.set(relative, snapshotFile(file.bytes, file.snapshot));
  }
  if (!directories.includes(".tfsb/assets")) {
    fail(ctx, "PROJECT_ASSETS_MISSING", "Canonical .tfsb/assets directory is missing.", ".tfsb/assets");
  }
  if (!files.has(".tfsb/project.toml")) {
    fail(ctx, "ROOT_NOT_FOUND", "Canonical project marker is missing.", ".tfsb/project.toml");
  }
  directories.sort();
  const canonicalAfter = await lstat(canonical);
  const rootAfter = await lstat(root);
  if (!canonicalAfter.isDirectory() || canonicalAfter.isSymbolicLink() || !sameFileIdentity(fileIdentity(canonicalStat), fileIdentity(canonicalAfter)) ||
    !rootAfter.isDirectory() || rootAfter.isSymbolicLink() || rootAfter.dev !== rootStat.dev || rootAfter.ino !== rootStat.ino) {
    fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", "Canonical tree changed during snapshot.", ".tfsb");
  }
  return {
    root, rootDev: rootStat.dev, rootIno: rootStat.ino, canonicalPresent: true,
    canonicalDev: canonicalStat.dev, canonicalIno: canonicalStat.ino,
    directories, directoryIdentities, files,
  };
}

export function snapshotsEqual(left: CanonicalSnapshot, right: CanonicalSnapshot): boolean {
  if (
    left.root !== right.root || left.rootDev !== right.rootDev || left.rootIno !== right.rootIno ||
    left.canonicalPresent !== right.canonicalPresent || left.canonicalDev !== right.canonicalDev ||
    left.canonicalIno !== right.canonicalIno || left.directories.join("\0") !== right.directories.join("\0") ||
    left.directoryIdentities.size !== right.directoryIdentities.size || left.files.size !== right.files.size
  ) return false;
  for (const [path, expected] of left.directoryIdentities) {
    const actual = right.directoryIdentities.get(path);
    if (actual === undefined || !sameFileIdentity(expected, actual)) return false;
  }
  for (const [path, expected] of left.files) {
    const actual = right.files.get(path);
    if (actual === undefined || actual.digest !== expected.digest || actual.dev !== expected.dev || actual.ino !== expected.ino ||
      actual.mode !== expected.mode || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs || actual.ctimeMs !== expected.ctimeMs) {
      return false;
    }
  }
  return true;
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableWrite(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  await syncPath(path);
}

function validateNextTree(nextFiles: CanonicalTree, operation: "import" | "reconcile" | "fmt"): void {
  const ctx = context(operation);
  if (!nextFiles.has(".tfsb/project.toml")) fail(ctx, "TRANSACTION_INVALID_PLAN", "Next tree lacks project.toml.");
  for (const path of nextFiles.keys()) {
    if (!supportedFile(path)) fail(ctx, "TRANSACTION_INVALID_PLAN", `Next tree contains unsupported path '${path}'.`, path);
  }
}

async function cleanupStage(stage: string): Promise<void> {
  await rm(stage, { recursive: true, force: true });
}

export async function executeCanonicalTransaction(options: CanonicalTransactionOptions): Promise<void> {
  const operation = options.operation ?? "reconcile";
  const ctx = context(operation);
  validateNextTree(options.nextFiles, operation);
  const root = options.expectedSnapshot.root;
  if (root !== await realpath(options.root)) fail(ctx, "ROOT_CHANGED", "Project root identity changed before mutation.");
  const residue = await findRecoveryResidue(root);
  if (residue.length > 0) {
    fail(ctx, "TFSB_RECOVERY_REQUIRED", `Recovery residue requires manual inspection: ${residue.join(", ")}.`, residue[0]);
  }
  const lock = join(root, ".tfsb.lock");
  let lockHandle;
  try {
    lockHandle = await open(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail(ctx, "ROOT_LOCKED", "Canonical mutation lock exists; inspect the active or stale .tfsb.lock before retrying.", ".tfsb.lock");
    }
    throw error;
  }
  const token = randomUUID();
  const stage = join(root, `.tfsb-stage-${token}`);
  const backup = join(root, `.tfsb-backup-${token}`);
  const canonical = join(root, ".tfsb");
  let backupCreated = false;
  let promoted = false;
  let inFlightError: unknown;
  try {
    await options.hooks?.beforeStageCreate?.();
    await mkdir(stage, { mode: 0o700 });
    await mkdir(join(stage, "assets"), { mode: 0o700 });
    const needsCompanions = [...options.nextFiles.keys()].some((path) => path.startsWith(".tfsb/companions/"));
    if (needsCompanions) await mkdir(join(stage, "companions"), { mode: 0o700 });
    await options.hooks?.beforeStageWrite?.();
    for (const [relative, bytes] of [...options.nextFiles.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      const inside = relative.slice(".tfsb/".length);
      const full = join(stage, inside);
      await mkdir(dirname(full), { recursive: true, mode: 0o700 });
      await durableWrite(full, bytes);
    }
    await syncPath(join(stage, "assets"));
    if (needsCompanions) await syncPath(join(stage, "companions"));
    await syncPath(stage);
    await options.hooks?.afterStageWrite?.();

    const current = await snapshotCanonicalTree(root, !options.expectedSnapshot.canonicalPresent, operation);
    if (!snapshotsEqual(options.expectedSnapshot, current)) {
      fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", "Canonical tree changed after reconciliation planning.");
    }
    if (options.archiveSnapshot !== undefined) await verifyArchiveSnapshot(options.archiveSnapshot, operation);
    if ((await findRecoveryResidue(root)).some((name) => name !== `.tfsb-stage-${token}`)) {
      fail(ctx, "TFSB_RECOVERY_REQUIRED", "Unexpected transaction residue appeared during mutation.");
    }
    if ((await optionalLstat(backup)) !== undefined) {
      fail(ctx, "TFSB_RECOVERY_REQUIRED", `Unexpected backup target '${`.tfsb-backup-${token}`}' appeared during mutation.`, `.tfsb-backup-${token}`);
    }
    await options.hooks?.beforeFirstRename?.();
    if (options.expectedSnapshot.canonicalPresent) {
      await rename(canonical, backup);
      backupCreated = true;
    }
    try {
      await options.hooks?.beforePromotion?.();
      if (!options.expectedSnapshot.canonicalPresent && (await optionalLstat(canonical)) !== undefined) {
        fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", "Canonical tree appeared after import planning.", ".tfsb");
      }
      await rename(stage, canonical);
      promoted = true;
      await options.hooks?.beforePromotionParentSync?.();
      await syncPath(root);
    } catch (promotionError) {
      if (promoted) {
        if (backupCreated) {
          fail(ctx, "TFSB_PROMOTION_DURABILITY_FAILED", `New canonical tree is active but parent fsync failed; backup '${`.tfsb-backup-${token}`}' was retained for inspection.`, `.tfsb-backup-${token}`);
        }
        fail(ctx, "TFSB_PROMOTION_DURABILITY_FAILED", "New canonical tree is active but parent fsync failed; no prior backup was created.");
      }
      if (backupCreated) {
        try {
          await options.hooks?.beforeRollback?.();
          await rename(backup, canonical);
          backupCreated = false;
          await syncPath(root);
        } catch {
          fail(ctx, "TFSB_ROLLBACK_FAILED", `Canonical promotion failed and rollback could not restore '${`.tfsb-backup-${token}`}'; inspect transaction residue.`, `.tfsb-backup-${token}`);
        }
      }
      throw promotionError;
    }
    if (backupCreated) {
      try {
        await options.hooks?.beforeBackupCleanup?.();
        await rm(backup, { recursive: true });
      } catch {
        fail(ctx, "TFSB_BACKUP_CLEANUP_FAILED", `New canonical tree is active but backup cleanup failed; inspect '${`.tfsb-backup-${token}`}'.`, `.tfsb-backup-${token}`);
      }
      backupCreated = false;
      try {
        await syncPath(root);
      } catch {
        fail(ctx, "TFSB_CLEANUP_DURABILITY_FAILED", "New canonical tree is active and backup was removed, but parent fsync failed.");
      }
    }
  } catch (error) {
    inFlightError = error;
    if (!promoted) {
      try {
        await cleanupStage(stage);
      } catch {
        const primary = error instanceof DiagnosticError ? ` after ${error.diagnostic.code}` : "";
        fail(ctx, "TFSB_STAGE_CLEANUP_FAILED", `Transaction failed${primary} and unpromoted stage cleanup failed; inspect '${`.tfsb-stage-${token}`}'.`, `.tfsb-stage-${token}`);
      }
    }
    if (error instanceof DiagnosticError) throw error;
    fail(ctx, "TFSB_TRANSACTION_FAILED", "Canonical transaction failed before completion.");
  } finally {
    let lockCleanupFailed = false;
    await lockHandle.close().catch(() => { lockCleanupFailed = true; });
    await rm(lock, { force: true }).catch(() => { lockCleanupFailed = true; });
    if (lockCleanupFailed) {
      const primary = inFlightError instanceof DiagnosticError ? ` after ${inFlightError.diagnostic.code}` : inFlightError === undefined ? "" : " after an earlier transaction failure";
      fail(ctx, "TFSB_LOCK_CLEANUP_FAILED", `Canonical operation ended${primary}, but .tfsb.lock cleanup failed; inspect it before retrying.`, ".tfsb.lock");
    }
  }
}
