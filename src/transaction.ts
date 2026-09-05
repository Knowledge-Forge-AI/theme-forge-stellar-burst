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
  readonly operation?: "import" | "edit" | "reconcile" | "fmt" | "migrate" | "install";
  /**
   * Optional validator for the staged tree.
   * Invoked immediately after stage creation and re-invoked in the final pre-promotion pass
   * after `beforePromotion`. Validators must be repeatable and side-effect free.
   */
  readonly validateStagedTree?: (stageRoot: string) => void | Promise<void>;
  /**
   * Optional validator for external state (such as an input archive or producer directory).
   * Invoked at transaction start, post-stage-write, and in the final pre-promotion pass
   * after `beforePromotion`. Validators must be repeatable and side-effect free.
   */
  readonly verifyExternalState?: () => void | Promise<void>;
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

import {
  BRAND_BASELINE_DIR,
  BRAND_BASELINE_MAX_AGGREGATE_BYTES,
  BRAND_BASELINE_MAX_FILE_BYTES,
  BRAND_BASELINE_MAX_FILES,
  BRAND_RASTER_RECEIPT_DIR,
  BRAND_RASTER_RECEIPT_MAX_FILE_BYTES,
  BRAND_RASTER_RECEIPT_MAX_FILES,
  getFixedBrandFile,
  isBrandBaselinePath,
  isDerivedReceiptPath,
  isRasterReceiptPath,
  isFixedBrandFilePath,
} from "./brand/brand-files.js";
import { DERIVED_RECEIPT_MAX_BYTES, DERIVED_RECEIPT_MAX_COUNT } from "./brand/derived-receipt.js";

function supportedFile(path: string): boolean {
  return path === ".tfsb/project.toml" || path === ".tfsb/provenance.json" || path === ".tfsb/brand.lock.json" ||
    isFixedBrandFilePath(path) ||
    isBrandBaselinePath(path) ||
    isRasterReceiptPath(path) ||
    isDerivedReceiptPath(path) ||
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
  const residue: string[] = [];
  const pending: { readonly absolute: string; readonly relative: string }[] = [{ absolute: root, relative: "" }];
  let inspected = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readDirectoryEntries(directory.absolute)) {
      inspected++;
      if (inspected > 100_000) fail(context(), "RESOURCE_LIMIT_EXCEEDED", "Recovery-residue inspection exceeded 100000 entries.");
      const relative = directory.relative === "" ? entry.name : `${directory.relative}/${entry.name}`;
      const isCanonicalResidue = directory.relative === "" && (entry.name.startsWith(".tfsb-stage-") || entry.name.startsWith(".tfsb-backup-"));
      const isConsumerJournal = directory.relative === "" && /^\.tfsb-consumer-transaction-[a-f0-9]{32}\.json$/.test(entry.name);
      const isConsumerStage = /^\..+\.tfsb-consumer-(?:stage|backup)-[a-f0-9]{32}$/.test(entry.name);
      const isRasterJournal = directory.relative === "" && /^\.tfsb-raster-transaction-[a-f0-9]{32}\.json$/.test(entry.name);
      const isRasterStage = /^\..+\.tfsb-raster-(?:stage|backup)-[a-f0-9]{32}$/.test(entry.name);
      if (isCanonicalResidue || isConsumerJournal || isConsumerStage || isRasterJournal || isRasterStage) residue.push(relative);
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".git" && entry.name !== "node_modules") {
        pending.push({ absolute: join(directory.absolute, entry.name), relative });
      }
    }
  }
  return residue.sort();
}

export async function snapshotCanonicalTree(
  rootInput: string,
  allowAbsent = false,
  operation: DiagnosticContext["operation"] = "reconcile",
  ignoredCanonicalFiles: ReadonlySet<string> = new Set(),
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
  let receiptCount = 0;
  let baselineCount = 0;
  let baselineBytes = 0;
  let rasterReceiptCount = 0;
  for (const entry of topEntries) {
    const relative = `.tfsb/${entry.name}`;
    if (ignoredCanonicalFiles.has(relative)) {
      const ignoredStat = await lstat(join(root, relative));
      if (!ignoredStat.isFile() || ignoredStat.isSymbolicLink()) {
        fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Ignored transaction entry '${relative}' is not a regular non-symlink file.`, relative);
      }
      continue;
    }
    if (entry.name === "brand-baselines") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported canonical entry '${relative}'.`, relative);
      directories.push(relative);
      const baselineDirectoryBefore = await lstat(join(root, relative));
      directoryIdentities.set(relative, fileIdentity(baselineDirectoryBefore));
      const profiles = await readDirectoryEntries(join(root, relative));
      if (profiles.length === 0) fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", "Brand baseline directory cannot be empty.", relative);
      for (const profile of profiles) {
        const profileRelative = `${relative}/${profile.name}`;
        if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(profile.name) || !profile.isDirectory() || profile.isSymbolicLink()) fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported baseline profile entry '${profileRelative}'.`, profileRelative);
        directories.push(profileRelative);
        const profileBefore = await lstat(join(root, profileRelative));
        directoryIdentities.set(profileRelative, fileIdentity(profileBefore));
        const baselineFiles = await readDirectoryEntries(join(root, profileRelative));
        if (baselineFiles.length === 0) fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Baseline profile directory '${profileRelative}' cannot be empty.`, profileRelative);
        for (const child of baselineFiles) {
          const childRelative = `${profileRelative}/${child.name}`;
          if (!child.isFile() || child.isSymbolicLink() || !isBrandBaselinePath(childRelative)) fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported baseline entry '${childRelative}'.`, childRelative);
          baselineCount++;
          if (baselineCount > BRAND_BASELINE_MAX_FILES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Brand baseline count exceeds ${BRAND_BASELINE_MAX_FILES}.`, childRelative);
          const file = await readRegularFileSnapshot(join(root, childRelative), ctx, "PROJECT_UNSUPPORTED_SOURCE", `Canonical baseline '${childRelative}' changed or became unsafe during snapshot.`, BRAND_BASELINE_MAX_FILE_BYTES);
          baselineBytes += file.bytes.byteLength;
          if (baselineBytes > BRAND_BASELINE_MAX_AGGREGATE_BYTES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Aggregate brand baseline bytes exceed 256 MiB.", BRAND_BASELINE_DIR);
          files.set(childRelative, snapshotFile(file.bytes, file.snapshot));
        }
        const profileAfter = await lstat(join(root, profileRelative));
        if (!profileAfter.isDirectory() || profileAfter.isSymbolicLink() || !sameFileIdentity(fileIdentity(profileBefore), fileIdentity(profileAfter))) fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", `Baseline profile directory '${profileRelative}' changed during snapshot.`, profileRelative);
      }
      const baselineDirectoryAfter = await lstat(join(root, relative));
      if (!baselineDirectoryAfter.isDirectory() || baselineDirectoryAfter.isSymbolicLink() || !sameFileIdentity(fileIdentity(baselineDirectoryBefore), fileIdentity(baselineDirectoryAfter))) fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", "Baseline directory changed during snapshot.", relative);
      continue;
    }
    if (entry.name === "raster-receipts") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported canonical entry '${relative}'.`, relative);
      directories.push(relative);
      const receiptDirectoryBefore = await lstat(join(root, relative));
      directoryIdentities.set(relative, fileIdentity(receiptDirectoryBefore));
      const profiles = await readDirectoryEntries(join(root, relative));
      if (profiles.length === 0) fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", "Raster receipt directory cannot be empty.", relative);
      for (const profile of profiles) {
        const profileRelative = `${relative}/${profile.name}`;
        if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(profile.name) || !profile.isDirectory() || profile.isSymbolicLink()) fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported raster receipt profile entry '${profileRelative}'.`, profileRelative);
        directories.push(profileRelative);
        const profileBefore = await lstat(join(root, profileRelative));
        directoryIdentities.set(profileRelative, fileIdentity(profileBefore));
        const receiptFiles = await readDirectoryEntries(join(root, profileRelative));
        if (receiptFiles.length === 0) fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Raster receipt profile directory '${profileRelative}' cannot be empty.`, profileRelative);
        for (const child of receiptFiles) {
          const childRelative = `${profileRelative}/${child.name}`;
          if (!child.isFile() || child.isSymbolicLink() || !isRasterReceiptPath(childRelative)) fail(ctx, "PROJECT_UNSUPPORTED_SOURCE", `Unsupported raster receipt entry '${childRelative}'.`, childRelative);
          rasterReceiptCount++;
          if (rasterReceiptCount > BRAND_RASTER_RECEIPT_MAX_FILES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Raster receipt count exceeds ${BRAND_RASTER_RECEIPT_MAX_FILES}.`, childRelative);
          const file = await readRegularFileSnapshot(join(root, childRelative), ctx, "PROJECT_UNSUPPORTED_SOURCE", `Canonical raster receipt '${childRelative}' changed or became unsafe during snapshot.`, BRAND_RASTER_RECEIPT_MAX_FILE_BYTES);
          files.set(childRelative, snapshotFile(file.bytes, file.snapshot));
        }
        const profileAfter = await lstat(join(root, profileRelative));
        if (!profileAfter.isDirectory() || profileAfter.isSymbolicLink() || !sameFileIdentity(fileIdentity(profileBefore), fileIdentity(profileAfter))) fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", `Raster receipt profile directory '${profileRelative}' changed during snapshot.`, profileRelative);
      }
      const receiptDirectoryAfter = await lstat(join(root, relative));
      if (!receiptDirectoryAfter.isDirectory() || receiptDirectoryAfter.isSymbolicLink() || !sameFileIdentity(fileIdentity(receiptDirectoryBefore), fileIdentity(receiptDirectoryAfter))) fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", "Raster receipt directory changed during snapshot.", BRAND_RASTER_RECEIPT_DIR);
      continue;
    }
    if (entry.name === "assets" || entry.name === "companions" || entry.name === "derived") {
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
        if (entry.name === "derived") {
          receiptCount++;
          if (receiptCount > DERIVED_RECEIPT_MAX_COUNT) {
            fail(
              ctx,
              "RESOURCE_LIMIT_EXCEEDED",
              `Derived receipts count exceeds limit ${DERIVED_RECEIPT_MAX_COUNT}.`,
              childRelative,
            );
          }
        }
        const full = join(root, childRelative);
        const file = await readRegularFileSnapshot(
          full,
          ctx,
          "PROJECT_UNSUPPORTED_SOURCE",
          `Canonical file '${childRelative}' changed or became unsafe during snapshot.`,
          entry.name === "derived" ? DERIVED_RECEIPT_MAX_BYTES : undefined,
        );
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
    const fixedBrand = getFixedBrandFile(relative);
    const file = await readRegularFileSnapshot(
      full,
      ctx,
      "PROJECT_UNSUPPORTED_SOURCE",
      `Canonical file '${relative}' changed or became unsafe during snapshot.`,
      relative === ".tfsb/brand.lock.json" ? 1_048_576 : fixedBrand?.maxBytes,
    );
    files.set(relative, snapshotFile(file.bytes, file.snapshot));
  }
  if (!directories.includes(".tfsb/assets")) {
    fail(ctx, "PROJECT_ASSETS_MISSING", "Canonical .tfsb/assets directory is missing.", ".tfsb/assets");
  }
  if (!files.has(".tfsb/project.toml")) {
    fail(ctx, "ROOT_NOT_FOUND", "Canonical project marker is missing.", ".tfsb/project.toml");
  }
  if (directories.includes(BRAND_BASELINE_DIR) && !files.has(".tfsb/brand-qa.toml")) fail(ctx, "BRAND_QA_BASELINES_WITHOUT_QA", "Brand baselines require enabled QA authority.", BRAND_BASELINE_DIR);
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

export function snapshotsEqualIgnoringDirectoryMetadata(
  left: CanonicalSnapshot,
  right: CanonicalSnapshot,
  ignoredDirectories: ReadonlySet<string>,
): boolean {
  if (
    left.root !== right.root || left.rootDev !== right.rootDev || left.rootIno !== right.rootIno ||
    left.canonicalPresent !== right.canonicalPresent || left.canonicalDev !== right.canonicalDev ||
    left.canonicalIno !== right.canonicalIno || left.directories.join("\0") !== right.directories.join("\0") ||
    left.directoryIdentities.size !== right.directoryIdentities.size || left.files.size !== right.files.size
  ) return false;
  for (const [path, expected] of left.directoryIdentities) {
    if (ignoredDirectories.has(path)) continue;
    const actual = right.directoryIdentities.get(path);
    if (actual === undefined || !sameFileIdentity(expected, actual)) return false;
  }
  for (const [path, expected] of left.files) {
    const actual = right.files.get(path);
    if (actual === undefined || actual.digest !== expected.digest || actual.dev !== expected.dev || actual.ino !== expected.ino ||
      actual.mode !== expected.mode || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs || actual.ctimeMs !== expected.ctimeMs) return false;
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

function validateNextTree(nextFiles: CanonicalTree, operation: "import" | "edit" | "reconcile" | "fmt" | "migrate" | "install"): void {
  const ctx = context(operation);
  if (!nextFiles.has(".tfsb/project.toml")) fail(ctx, "TRANSACTION_INVALID_PLAN", "Next tree lacks project.toml.");
  let receiptCount = 0;
  let baselineCount = 0;
  let baselineBytes = 0;
  let rasterReceiptCount = 0;
  for (const [path, bytes] of nextFiles) {
    if (!supportedFile(path)) fail(ctx, "TRANSACTION_INVALID_PLAN", `Next tree contains unsupported path '${path}'.`, path);
    const fixedBrand = getFixedBrandFile(path);
    if (fixedBrand !== undefined && bytes.byteLength > fixedBrand.maxBytes) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        `Fixed brand file '${path}' (${bytes.byteLength} bytes) exceeds limit ${fixedBrand.maxBytes} bytes.`,
        path,
      );
    }
    if (path === ".tfsb/brand.lock.json" && bytes.byteLength > 1_048_576) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "brand.lock.json exceeds 1 MiB.", path);
    if (isDerivedReceiptPath(path)) {
      receiptCount++;
      if (receiptCount > DERIVED_RECEIPT_MAX_COUNT) {
        fail(
          ctx,
          "RESOURCE_LIMIT_EXCEEDED",
          `Derived receipts count exceeds limit ${DERIVED_RECEIPT_MAX_COUNT}.`,
          path,
        );
      }
      if (bytes.byteLength > DERIVED_RECEIPT_MAX_BYTES) {
        fail(
          ctx,
          "RESOURCE_LIMIT_EXCEEDED",
          `Derived receipt '${path}' (${bytes.byteLength} bytes) exceeds limit ${DERIVED_RECEIPT_MAX_BYTES} bytes.`,
          path,
        );
      }
    }
    if (isBrandBaselinePath(path)) {
      baselineCount++;
      baselineBytes += bytes.byteLength;
      if (baselineCount > BRAND_BASELINE_MAX_FILES || bytes.byteLength > BRAND_BASELINE_MAX_FILE_BYTES || baselineBytes > BRAND_BASELINE_MAX_AGGREGATE_BYTES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Brand baseline limits exceeded.", path);
    }
    if (isRasterReceiptPath(path)) {
      rasterReceiptCount++;
      if (rasterReceiptCount > BRAND_RASTER_RECEIPT_MAX_FILES || bytes.byteLength > BRAND_RASTER_RECEIPT_MAX_FILE_BYTES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Raster receipt limits exceeded.", path);
    }
  }
  if (baselineCount > 0 && !nextFiles.has(".tfsb/brand-qa.toml")) fail(ctx, "TRANSACTION_INVALID_PLAN", "Brand baselines require brand-qa.toml.", BRAND_BASELINE_DIR);
  if (rasterReceiptCount > 0 && !nextFiles.has(".tfsb/brand-exports.toml")) fail(ctx, "TRANSACTION_INVALID_PLAN", "Raster receipts require brand-exports.toml.", BRAND_RASTER_RECEIPT_DIR);
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
  let lockIdentity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    lockHandle = await open(lock, "wx", 0o600);
    const stat = await lockHandle.stat();
    lockIdentity = { dev: stat.dev, ino: stat.ino };
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
    await options.verifyExternalState?.();
    await options.hooks?.beforeStageCreate?.();
    await mkdir(stage, { mode: 0o700 });
    await mkdir(join(stage, "assets"), { mode: 0o700 });
    const needsCompanions = [...options.nextFiles.keys()].some((path) => path.startsWith(".tfsb/companions/"));
    if (needsCompanions) await mkdir(join(stage, "companions"), { mode: 0o700 });
    const needsDerived = [...options.nextFiles.keys()].some((path) => path.startsWith(".tfsb/derived/"));
    if (needsDerived) await mkdir(join(stage, "derived"), { mode: 0o700 });
    const baselineProfiles = [...new Set([...options.nextFiles.keys()].filter(isBrandBaselinePath).map((path) => path.split("/")[2]!))].sort();
    if (baselineProfiles.length > 0) await mkdir(join(stage, "brand-baselines"), { mode: 0o700 });
    await options.hooks?.beforeStageWrite?.();
    for (const [relative, bytes] of [...options.nextFiles.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      const inside = relative.slice(".tfsb/".length);
      const full = join(stage, inside);
      await mkdir(dirname(full), { recursive: true, mode: 0o700 });
      await durableWrite(full, bytes);
    }
    await syncPath(join(stage, "assets"));
    if (needsCompanions) await syncPath(join(stage, "companions"));
    if (needsDerived) await syncPath(join(stage, "derived"));
    for (const profile of baselineProfiles) await syncPath(join(stage, "brand-baselines", profile));
    if (baselineProfiles.length > 0) await syncPath(join(stage, "brand-baselines"));
    await syncPath(stage);
    await options.hooks?.afterStageWrite?.();
    await options.validateStagedTree?.(stage);

    const current = await snapshotCanonicalTree(root, !options.expectedSnapshot.canonicalPresent, operation);
    if (!snapshotsEqual(options.expectedSnapshot, current)) {
      fail(ctx, "CANONICAL_CHANGED_DURING_PLAN", "Canonical tree changed after reconciliation planning.");
    }
    if (options.archiveSnapshot !== undefined) await verifyArchiveSnapshot(options.archiveSnapshot, operation);
    await options.verifyExternalState?.();
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
      await options.validateStagedTree?.(stage);
      if (options.archiveSnapshot !== undefined) await verifyArchiveSnapshot(options.archiveSnapshot, operation);
      if (options.verifyExternalState !== undefined) {
        try {
          await options.verifyExternalState();
        } catch (extErr) {
          if (backupCreated && extErr instanceof DiagnosticError && extErr.diagnostic.code === "ROOT_NOT_FOUND") {
            // Canonical tree was backed up to backup location during promotion window
          } else {
            throw extErr;
          }
        }
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
    const currentLock = await optionalLstat(lock).catch(() => undefined);
    if (currentLock === undefined || currentLock.isSymbolicLink() || currentLock.dev !== lockIdentity?.dev || currentLock.ino !== lockIdentity.ino) lockCleanupFailed = true;
    else await rm(lock).catch(() => { lockCleanupFailed = true; });
    if (lockCleanupFailed) {
      const primary = inFlightError instanceof DiagnosticError ? ` after ${inFlightError.diagnostic.code}` : inFlightError === undefined ? "" : " after an earlier transaction failure";
      fail(ctx, "TFSB_LOCK_CLEANUP_FAILED", `Canonical operation ended${primary}, but .tfsb.lock cleanup failed; inspect it before retrying.`, ".tfsb.lock");
    }
  }
}
