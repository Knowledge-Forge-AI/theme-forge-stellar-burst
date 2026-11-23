import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, mkdir, open, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { DiagnosticError, fail } from "./diagnostics.js";
import { computeRawSha256 } from "./digests.js";
import {
  durableWrite,
  identity,
  readExactBuffer,
  readRegularFileSnapshot,
  sameFileIdentity,
  syncPath,
  type FileIdentity,
  type PresentFileSnapshot,
} from "./filesystem.js";
import { findRecoveryResidue, withCanonicalMutationLock } from "./transaction.js";

export type ManagedOutputNamespace = "consumer" | "illustration";

export interface ManagedOutputSnapshot {
  readonly kind: "absent" | "file";
  readonly identity?: FileIdentity;
  readonly digest?: string;
}

export interface ManagedOutputParentAuthority {
  readonly nearestPath: string;
  readonly nearestIdentity: FileIdentity;
  readonly nearestHandle: FileHandle;
  readonly missingDirectories: readonly string[];
}

/**
 * A plan-owned output. Existing files must retain a no-follow descriptor and
 * parent authority until execution; absent files have no target descriptor.
 */
export interface ManagedOutput {
  readonly destination: string;
  readonly absoluteDestination: string;
  readonly bytes: Uint8Array;
  readonly snapshot: ManagedOutputSnapshot;
  readonly handle?: FileHandle;
  readonly parentAuthority: ManagedOutputParentAuthority;
  readonly maxBytes: number;
}

export interface ManagedOutputTransactionHooks {
  readonly beforeStage?: (index: number) => void | Promise<void>;
  readonly afterStage?: (index: number) => void | Promise<void>;
  readonly beforeJournal?: () => void | Promise<void>;
  readonly afterJournal?: () => void | Promise<void>;
  readonly beforeOutputPromotion?: (index: number) => void | Promise<void>;
  readonly beforeLockPromotion?: () => void | Promise<void>;
  readonly beforeRollback?: (index: number) => void | Promise<void>;
  readonly beforeCleanup?: (index: number) => void | Promise<void>;
}

export interface ManagedOutputTransactionOptions {
  readonly root: string;
  readonly namespace: ManagedOutputNamespace;
  readonly outputs: readonly ManagedOutput[];
  /** The final metadata/lock output. It is always staged and promoted last. */
  readonly lock: ManagedOutput;
  /** Internal brand compatibility: an authenticated lockDigest may be unchanged despite serializer bytes. */
  readonly semanticLockUnchanged?: boolean;
  /** Revalidate retained source handles and bytes. */
  readonly verifySource: () => void | Promise<void>;
  /** Revalidate project/profile/lock state. The callback may ignore an authenticated lock stage. */
  readonly verifyProject: (ignoredCanonicalFiles: readonly string[]) => void | Promise<void>;
  readonly hooks?: ManagedOutputTransactionHooks;
}

export interface ManagedOutputTransactionResult {
  readonly writtenOutputs: number;
}

interface DiagnosticCodes {
  readonly parentChanged: string;
  readonly destinationChanged: string;
  readonly stageChanged: string;
  readonly ownedFileUnsafe: string;
  readonly backupChanged: string;
  readonly journalChanged: string;
  readonly recoveryRequired: string;
  readonly transactionRolledBack: string;
}

interface Staged {
  readonly destination: string;
  readonly relativeDestination: string;
  readonly stage: string;
  readonly backup: string;
  readonly bytes: Uint8Array;
  readonly maxBytes: number;
  readonly stageHandle: FileHandle;
  readonly stageIdentity: FileIdentity;
  readonly expectedKind: "absent" | "file";
  readonly expectedIdentity?: FileIdentity;
  readonly expectedDigest?: string;
  readonly parentPath: string;
  readonly parentIdentity: FileIdentity;
  readonly parentHandle: FileHandle;
  promoted: boolean;
  promotedIdentity?: FileIdentity;
  backedUp: boolean;
}

function context() {
  return { operation: "install" as const, domain: "transaction" as const };
}

function label(namespace: ManagedOutputNamespace): string {
  return namespace === "consumer" ? "Consumer" : "Illustration";
}

function codes(namespace: ManagedOutputNamespace): DiagnosticCodes {
  const prefix = namespace === "consumer" ? "CONSUMER" : "ILLUSTRATION";
  return {
    parentChanged: `${prefix}_PARENT_CHANGED`,
    destinationChanged: `${prefix}_DESTINATION_CHANGED`,
    stageChanged: `${prefix}_STAGE_CHANGED`,
    ownedFileUnsafe: `${prefix}_OWNED_FILE_UNSAFE`,
    backupChanged: `${prefix}_BACKUP_CHANGED`,
    journalChanged: `${prefix}_JOURNAL_CHANGED`,
    recoveryRequired: `${prefix}_RECOVERY_REQUIRED`,
    transactionRolledBack: `${prefix}_TRANSACTION_ROLLED_BACK`,
  };
}

function sha(bytes: Uint8Array): string {
  return `sha256:${computeRawSha256(bytes)}`;
}

function sameDirectoryAuthority(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

/** Ownership is inode-based; unlinking the stage may legitimately update ctime. */
function sameOwnedFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function verifyDirectory(
  namespace: ManagedOutputNamespace,
  path: string,
  expected: FileIdentity,
  handle: FileHandle,
): Promise<void> {
  const named = await lstat(path).catch(() => undefined);
  const opened = await handle.stat().catch(() => undefined);
  if (
    named === undefined || opened === undefined || named.isSymbolicLink() || !named.isDirectory() ||
    !opened.isDirectory() || !sameDirectoryAuthority(identity(named), expected) ||
    !sameDirectoryAuthority(identity(opened), expected)
  ) {
    fail(context(), codes(namespace).parentChanged, `${label(namespace)} destination parent authority changed.`);
  }
}

async function ensureParent(
  namespace: ManagedOutputNamespace,
  authority: ManagedOutputParentAuthority,
  created: Map<string, FileIdentity>,
  retainedHandles: FileHandle[],
): Promise<{ readonly path: string; readonly identity: FileIdentity; readonly handle: FileHandle }> {
  await verifyDirectory(namespace, authority.nearestPath, authority.nearestIdentity, authority.nearestHandle);
  for (const path of authority.missingDirectories) {
    const existingOwned = created.get(path);
    if (existingOwned !== undefined) {
      const stat = await lstat(path).catch(() => undefined);
      if (
        stat === undefined || stat.isSymbolicLink() || !stat.isDirectory() ||
        !sameDirectoryAuthority(identity(stat), existingOwned)
      ) {
        fail(context(), codes(namespace).parentChanged, `${label(namespace)}-created destination parent changed.`);
      }
      continue;
    }
    if (await lstat(path).catch(() => undefined) !== undefined) {
      fail(context(), codes(namespace).parentChanged, `A missing ${label(namespace).toLowerCase()} destination parent appeared after planning.`);
    }
    await mkdir(path, { mode: 0o700 });
    const createdStat = await lstat(path);
    if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
      fail(context(), codes(namespace).parentChanged, `${label(namespace)} destination parent creation was unsafe.`);
    }
    created.set(path, identity(createdStat));
  }
  const parentPath = authority.missingDirectories.at(-1) ?? authority.nearestPath;
  if (parentPath === authority.nearestPath) {
    return { path: parentPath, identity: authority.nearestIdentity, handle: authority.nearestHandle };
  }
  const parentHandle = await open(parentPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  retainedHandles.push(parentHandle);
  const parentStat = await parentHandle.stat();
  if (!parentStat.isDirectory()) {
    fail(context(), codes(namespace).parentChanged, `${label(namespace)} destination parent is unsafe after creation.`);
  }
  const parentIdentity = identity(parentStat);
  const createdIdentity = created.get(parentPath);
  if (createdIdentity !== undefined && !sameDirectoryAuthority(parentIdentity, createdIdentity)) {
    fail(context(), codes(namespace).parentChanged, `${label(namespace)}-created destination parent changed after creation.`);
  }
  return { path: parentPath, identity: parentIdentity, handle: parentHandle };
}

/** Descriptor-verified target check used before each output promotion. */
export async function verifyManagedOutput(output: ManagedOutput, namespace: ManagedOutputNamespace): Promise<void> {
  const current = await lstat(output.absoluteDestination).catch(() => undefined);
  const diagnosticCodes = codes(namespace);
  if (output.snapshot.kind === "absent") {
    if (current !== undefined) {
      fail(context(), diagnosticCodes.destinationChanged, `Destination '${output.destination}' appeared after planning.`, output.destination);
    }
    return;
  }
  if (
    current === undefined || current.isSymbolicLink() || !current.isFile() || output.snapshot.identity === undefined ||
    !sameFileIdentity(identity(current), output.snapshot.identity)
  ) {
    fail(context(), diagnosticCodes.destinationChanged, `Destination '${output.destination}' changed after planning.`, output.destination);
  }
  if (output.handle !== undefined) {
    const opened = await output.handle.stat();
    if (!sameFileIdentity(identity(opened), output.snapshot.identity)) {
      fail(context(), diagnosticCodes.destinationChanged, `Opened destination '${output.destination}' changed.`, output.destination);
    }
    const bytes = await readExactBuffer(output.handle, opened.size, 0, context(), output.maxBytes);
    if (sha(bytes) !== output.snapshot.digest) {
      fail(context(), diagnosticCodes.destinationChanged, `Destination '${output.destination}' bytes changed.`, output.destination);
    }
    return;
  }
  const read = await readRegularFileSnapshot(
    output.absoluteDestination,
    context(),
    diagnosticCodes.destinationChanged,
    `Destination '${output.destination}' changed after planning.`,
    output.maxBytes,
  );
  if (!sameFileIdentity(read.snapshot, output.snapshot.identity) || sha(read.bytes) !== output.snapshot.digest) {
    fail(context(), diagnosticCodes.destinationChanged, `Destination '${output.destination}' changed after planning.`, output.destination);
  }
}

/** The stage is still our staged inode with our bytes, read through its descriptor. */
async function stageStillOwned(item: Staged, namespace: ManagedOutputNamespace): Promise<boolean> {
  const stat = await lstat(item.stage).catch(() => undefined);
  const opened = await item.stageHandle.stat().catch(() => undefined);
  if (
    stat === undefined || opened === undefined || stat.isSymbolicLink() || !stat.isFile() || !opened.isFile() ||
    !sameFileIdentity(identity(stat), item.stageIdentity) || !sameFileIdentity(identity(opened), item.stageIdentity) ||
    stat.size !== item.bytes.byteLength
  ) return false;
  const bytes = await readExactBuffer(item.stageHandle, opened.size, 0, context(), item.maxBytes).catch(() => undefined);
  return bytes !== undefined && sha(bytes) === sha(item.bytes);
}

async function verifyStage(item: Staged, namespace: ManagedOutputNamespace): Promise<void> {
  if (!(await stageStillOwned(item, namespace))) {
    fail(context(), codes(namespace).stageChanged, `${label(namespace)} staged output changed before promotion.`, item.relativeDestination);
  }
}

async function removeOwnedStage(item: Staged, namespace: ManagedOutputNamespace): Promise<boolean> {
  const stat = await lstat(item.stage).catch(() => undefined);
  if (stat === undefined) return true;
  if (!(await stageStillOwned(item, namespace))) return false;
  await rm(item.stage);
  return true;
}

/** Descriptor-verified read of one regular non-symlink file. */
async function readOwnedFile(
  path: string,
  namespace: ManagedOutputNamespace,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly snapshot: PresentFileSnapshot } | undefined> {
  try {
    return await readRegularFileSnapshot(
      path,
      context(),
      codes(namespace).ownedFileUnsafe,
      `${label(namespace)}-owned file is not one stable regular file.`,
      maxBytes,
    );
  } catch (error) {
    if (error instanceof DiagnosticError) return undefined;
    throw error;
  }
}

async function verifyTransactionState(
  options: ManagedOutputTransactionOptions,
  staged: readonly Staged[],
): Promise<void> {
  for (const output of options.outputs) {
    const item = staged.find((entry) => entry.relativeDestination === output.destination);
    if (item?.promoted === true) {
      const promoted = await readOwnedFile(item.destination, options.namespace, item.maxBytes);
      if (
        promoted === undefined || item.promotedIdentity === undefined ||
        !sameOwnedFileIdentity(promoted.snapshot, item.promotedIdentity) ||
        sha(promoted.bytes) !== sha(item.bytes)
      ) {
        fail(context(), codes(options.namespace).destinationChanged, `Promoted destination '${item.relativeDestination}' changed.`, item.relativeDestination);
      }
    } else {
      await verifyManagedOutput(output, options.namespace);
    }
  }
  for (const item of staged) {
    if (!item.promoted) await verifyStage(item, options.namespace);
    await verifyDirectory(options.namespace, item.parentPath, item.parentIdentity, item.parentHandle);
  }
}

async function removeOwned(
  item: Staged,
  namespace: ManagedOutputNamespace,
): Promise<boolean> {
  const stat = await lstat(item.destination).catch(() => undefined);
  if (stat === undefined) return true;
  if (
    stat.isSymbolicLink() || !stat.isFile() || item.promotedIdentity === undefined ||
    !sameOwnedFileIdentity(identity(stat), item.promotedIdentity)
  ) return false;
  const owned = await readOwnedFile(item.destination, namespace, item.maxBytes);
  if (
    owned === undefined || !sameOwnedFileIdentity(owned.snapshot, item.promotedIdentity) ||
    sha(owned.bytes) !== sha(item.bytes)
  ) return false;
  await rm(item.destination);
  return true;
}

async function verifyBackup(item: Staged, namespace: ManagedOutputNamespace): Promise<void> {
  if (!item.backedUp || item.expectedIdentity === undefined || item.expectedDigest === undefined) return;
  const backup = await readOwnedFile(item.backup, namespace, item.maxBytes);
  const current = backup?.snapshot;
  if (
    backup === undefined || current === undefined || current.dev !== item.expectedIdentity.dev ||
    current.ino !== item.expectedIdentity.ino || current.mode !== item.expectedIdentity.mode ||
    current.size !== item.expectedIdentity.size || sha(backup.bytes) !== item.expectedDigest
  ) {
    fail(context(), codes(namespace).backupChanged, `${label(namespace)} transaction backup changed.`, item.relativeDestination);
  }
}

function transactionPrefix(namespace: ManagedOutputNamespace): string {
  return namespace === "consumer" ? "consumer" : "illustration";
}

function transactionSchema(namespace: ManagedOutputNamespace): string {
  return `tfsb.${transactionPrefix(namespace)}-transaction`;
}

function ignoredCanonicalFiles(root: string, lockStage: string): readonly string[] {
  const relativeLockStage = relative(root, lockStage).split(sep).join("/");
  return relativeLockStage.startsWith(".tfsb/") ? [relativeLockStage] : [];
}

function changed(output: ManagedOutput): boolean {
  return output.snapshot.kind === "absent" || output.snapshot.digest !== sha(output.bytes);
}

function validateBound(output: ManagedOutput, namespace: ManagedOutputNamespace): void {
  if (!Number.isSafeInteger(output.maxBytes) || output.maxBytes < 1 || output.bytes.byteLength > output.maxBytes) {
    fail(context(), "RESOURCE_LIMIT_EXCEEDED", `${label(namespace)} managed output exceeds its fixed byte limit.`, output.destination);
  }
}

async function promote(item: Staged, namespace: ManagedOutputNamespace): Promise<void> {
  await link(item.stage, item.destination);
  item.promoted = true;
  const promoted = await lstat(item.destination).catch(() => undefined);
  if (
    promoted === undefined || promoted.isSymbolicLink() || !promoted.isFile() ||
    !sameOwnedFileIdentity(identity(promoted), item.stageIdentity)
  ) {
    fail(context(), codes(namespace).destinationChanged, `Promoted destination '${item.relativeDestination}' changed.`, item.relativeDestination);
  }
  item.promotedIdentity = identity(promoted);
  await rm(item.stage);
  await syncPath(dirname(item.destination));
}

export async function executeManagedOutputTransaction(
  options: ManagedOutputTransactionOptions,
): Promise<ManagedOutputTransactionResult> {
  for (const output of [...options.outputs, options.lock]) validateBound(output, options.namespace);
  const transactionOutputs = options.outputs.filter(changed);
  const lockChanged = options.semanticLockUnchanged === true ? false : changed(options.lock);

  return withCanonicalMutationLock(options.root, "install", async () => {
    const residue = await findRecoveryResidue(options.root);
    if (residue.length > 0) {
      fail(context(), "TFSB_RECOVERY_REQUIRED", `Recovery residue requires manual inspection: ${residue.join(", ")}.`, residue[0]);
    }
    await options.verifyProject([]);
    await options.verifySource();
    for (const output of options.outputs) await verifyManagedOutput(output, options.namespace);
    if (transactionOutputs.length === 0 && !lockChanged) {
      return { writtenOutputs: 0 };
    }

    const token = randomUUID().replace(/-/g, "");
    const staged: Staged[] = [];
    const createdDirectories = new Map<string, FileIdentity>();
    const retainedParentHandles: FileHandle[] = [];
    const unresolvedStages: string[] = [];
    const prefix = transactionPrefix(options.namespace);
    const journal = `${options.root}/.tfsb-${prefix}-transaction-${token}.json`;
    let journalBytes = Buffer.alloc(0);
    let journalWritten = false;
    let journalHandle: FileHandle | undefined;
    let journalIdentity: FileIdentity | undefined;
    let lockPromoted = false;

    const verifyJournal = async (): Promise<void> => {
      const named = await lstat(journal).catch(() => undefined);
      const opened = await journalHandle?.stat().catch(() => undefined);
      if (
        named === undefined || opened === undefined || journalIdentity === undefined || named.isSymbolicLink() ||
        !named.isFile() || !sameFileIdentity(identity(named), journalIdentity) ||
        !sameFileIdentity(identity(opened), journalIdentity) ||
        sha(await readExactBuffer(journalHandle!, opened.size, 0, context(), 1_048_576)) !== sha(journalBytes)
      ) {
        fail(context(), codes(options.namespace).journalChanged, `${label(options.namespace)} transaction journal changed.`);
      }
    };

    const stageOutput = async (output: ManagedOutput, index: number): Promise<void> => {
      await options.hooks?.beforeStage?.(index);
      const parentAuthority = await ensureParent(options.namespace, output.parentAuthority, createdDirectories, retainedParentHandles);
      const stage = join(parentAuthority.path, `.${basename(output.absoluteDestination)}.tfsb-${prefix}-stage-${token}`);
      const backup = join(parentAuthority.path, `.${basename(output.absoluteDestination)}.tfsb-${prefix}-backup-${token}`);
      let stageHandle: FileHandle | undefined;
      let stageAttempted = false;
      try {
        stageAttempted = true;
        await durableWrite(stage, output.bytes);
        await syncPath(parentAuthority.path);
        stageHandle = await open(stage, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stageIdentity = identity(await stageHandle.stat());
        staged.push({
          destination: output.absoluteDestination,
          relativeDestination: output.destination,
          stage,
          backup,
          bytes: Buffer.from(output.bytes),
          maxBytes: output.maxBytes,
          stageHandle,
          stageIdentity,
          expectedKind: output.snapshot.kind,
          ...(output.snapshot.identity === undefined ? {} : { expectedIdentity: output.snapshot.identity }),
          ...(output.snapshot.digest === undefined ? {} : { expectedDigest: output.snapshot.digest }),
          parentPath: parentAuthority.path,
          parentIdentity: parentAuthority.identity,
          parentHandle: parentAuthority.handle,
          promoted: false,
          backedUp: false,
        });
      } catch (error) {
        await stageHandle?.close().catch(() => undefined);
        if (stageAttempted) unresolvedStages.push(stage);
        throw error;
      }
      await options.hooks?.afterStage?.(index);
    };

    try {
      for (const [index, output] of transactionOutputs.entries()) await stageOutput(output, index);
      const lockParentAuthority = await ensureParent(options.namespace, options.lock.parentAuthority, createdDirectories, retainedParentHandles);
      const lockStage = join(lockParentAuthority.path, `.${basename(options.lock.absoluteDestination)}.tfsb-${prefix}-stage-${token}`);
      const lockBackup = join(lockParentAuthority.path, `.${basename(options.lock.absoluteDestination)}.tfsb-${prefix}-backup-${token}`);
      await options.hooks?.beforeStage?.(staged.length);
      let lockStageHandle: FileHandle | undefined;
      let lockStageAttempted = false;
      try {
        lockStageAttempted = true;
        await durableWrite(lockStage, options.lock.bytes);
        await syncPath(lockParentAuthority.path);
        lockStageHandle = await open(lockStage, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const lockStageIdentity = identity(await lockStageHandle.stat());
        staged.push({
          destination: options.lock.absoluteDestination,
          relativeDestination: options.lock.destination,
          stage: lockStage,
          backup: lockBackup,
          bytes: Buffer.from(options.lock.bytes),
          maxBytes: options.lock.maxBytes,
          stageHandle: lockStageHandle,
          stageIdentity: lockStageIdentity,
          expectedKind: options.lock.snapshot.kind,
          ...(options.lock.snapshot.identity === undefined ? {} : { expectedIdentity: options.lock.snapshot.identity }),
          ...(options.lock.snapshot.digest === undefined ? {} : { expectedDigest: options.lock.snapshot.digest }),
          parentPath: lockParentAuthority.path,
          parentIdentity: lockParentAuthority.identity,
          parentHandle: lockParentAuthority.handle,
          promoted: false,
          backedUp: false,
        });
      } catch (error) {
        await lockStageHandle?.close().catch(() => undefined);
        if (lockStageAttempted) unresolvedStages.push(lockStage);
        throw error;
      }
      await options.hooks?.afterStage?.(staged.length - 1);
      await options.hooks?.beforeJournal?.();
      // Keep the private journal's canonical key order without importing the brand package.
      journalBytes = Buffer.from(`${JSON.stringify({
        entries: staged.map((entry) => ({ backup: basename(entry.backup), destination: entry.relativeDestination, stage: basename(entry.stage) })),
        lockLast: true,
        schema: transactionSchema(options.namespace),
        schemaVersion: 1,
      })}\n`, "utf8");
      await durableWrite(journal, journalBytes);
      journalWritten = true;
      journalHandle = await open(journal, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      journalIdentity = identity(await journalHandle.stat());
      await syncPath(options.root);
      await options.hooks?.afterJournal?.();

      const ignored = ignoredCanonicalFiles(options.root, lockStage);
      for (let index = 0; index < transactionOutputs.length; index += 1) {
        await options.hooks?.beforeOutputPromotion?.(index);
        await options.verifyProject(ignored);
        await options.verifySource();
        await verifyTransactionState(options, staged);
        await verifyJournal();
        const item = staged[index]!;
        if (item.expectedKind === "file") {
          await rename(item.destination, item.backup);
          item.backedUp = true;
          await verifyBackup(item, options.namespace);
        }
        await promote(item, options.namespace);
      }
      await options.hooks?.beforeLockPromotion?.();
      await options.verifyProject(ignored);
      await options.verifySource();
      await verifyTransactionState(options, staged);
      await verifyJournal();
      const lock = staged.at(-1)!;
      if (lock.expectedKind === "file") {
        await rename(lock.destination, lock.backup);
        lock.backedUp = true;
        await verifyBackup(lock, options.namespace);
      }
      await promote(lock, options.namespace);
      lockPromoted = true;
    } catch (error) {
      let recoveryRequired = unresolvedStages.length > 0;
      for (let index = staged.length - 1; index >= 0; index -= 1) {
        const item = staged[index]!;
        try {
          await options.hooks?.beforeRollback?.(index);
          if (item.promoted && !(await removeOwned(item, options.namespace))) {
            recoveryRequired = true;
            continue;
          }
          if (item.backedUp) {
            const current = await lstat(item.destination).catch(() => undefined);
            if (current !== undefined) {
              recoveryRequired = true;
              continue;
            }
            await verifyBackup(item, options.namespace);
            await rename(item.backup, item.destination);
            item.backedUp = false;
          }
          if (!(await removeOwnedStage(item, options.namespace))) {
            recoveryRequired = true;
            continue;
          }
          await syncPath(dirname(item.destination));
          await item.stageHandle.close();
        } catch {
          recoveryRequired = true;
        }
      }
      for (const [path, expected] of [...createdDirectories].reverse()) {
        try {
          const stat = await lstat(path).catch(() => undefined);
          if (stat !== undefined && sameDirectoryAuthority(identity(stat), expected)) await rmdir(path);
          else if (stat !== undefined) recoveryRequired = true;
        } catch {
          recoveryRequired = true;
        }
      }
      for (const item of staged) await item.stageHandle.close().catch(() => { recoveryRequired = true; });
      for (const handle of retainedParentHandles) await handle.close().catch(() => { recoveryRequired = true; });
      if (journalWritten) await verifyJournal().catch(() => { recoveryRequired = true; });
      await journalHandle?.close().catch(() => { recoveryRequired = true; });
      if (!recoveryRequired && journalWritten) {
        await rm(journal, { force: true });
        await syncPath(options.root);
      }
      const priorCode = error instanceof DiagnosticError ? ` after ${error.diagnostic.code}` : "";
      throw new DiagnosticError({
        code: recoveryRequired ? codes(options.namespace).recoveryRequired : codes(options.namespace).transactionRolledBack,
        operation: "install",
        domain: "transaction",
        message: recoveryRequired
          ? `${label(options.namespace)} transaction failed${priorCode} and retained recovery residue.`
          : `${label(options.namespace)} transaction failed${priorCode} and was rolled back.`,
        ...(error instanceof DiagnosticError && error.diagnostic.location !== undefined ? { location: error.diagnostic.location } : {}),
      });
    }

    let cleanupFailed = false;
    for (const [index, item] of staged.entries()) {
      try {
        await options.hooks?.beforeCleanup?.(index);
        if (item.backedUp) {
          await verifyBackup(item, options.namespace);
          await rm(item.backup);
        }
        if (!(await removeOwnedStage(item, options.namespace))) throw new Error("stage ownership changed");
        await item.stageHandle.close();
        await syncPath(dirname(item.destination));
      } catch {
        cleanupFailed = true;
      }
    }
    for (const handle of retainedParentHandles) await handle.close().catch(() => { cleanupFailed = true; });
    if (journalWritten) await verifyJournal().catch(() => { cleanupFailed = true; });
    await journalHandle?.close().catch(() => { cleanupFailed = true; });
    if (!cleanupFailed) {
      await rm(journal, { force: true });
      await syncPath(options.root);
    }
    for (const item of staged) await item.stageHandle.close().catch(() => { cleanupFailed = true; });
    if (cleanupFailed || !lockPromoted) {
      fail(context(), codes(options.namespace).recoveryRequired, `${label(options.namespace)} transaction completed promotion but retained recovery residue.`);
    }
    return { writtenOutputs: transactionOutputs.length };
  });
}
