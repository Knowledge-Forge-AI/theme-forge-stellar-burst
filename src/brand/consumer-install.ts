import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, mkdir, open, readFile, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { DiagnosticError, fail } from "../diagnostics.js";
import { computeRawSha256 } from "../digests.js";
import { durableWrite, identity, readExactBuffer, sameFileIdentity, syncPath } from "../filesystem.js";
import { executeCanonicalTransaction, findRecoveryResidue, withCanonicalMutationLock } from "../transaction.js";
import { verifyLoadedProjectSnapshot } from "../project.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import { serializeConsumerBrandLock } from "./consumer-lock.js";
import { revalidateConsumerSources } from "./consumer-source.js";
import {
  disposeConsumerPlan,
  getConsumerPlanInternals,
  type ConsumerAdoptionPlan,
  type ConsumerInstallPlan,
  type ConsumerPlanInternals,
  type ConsumerPlanSummary,
  type ConsumerSyncPlan,
} from "./consumer-plan.js";

export interface ConsumerTransactionHooks {
  readonly beforeStage?: (index: number) => void | Promise<void>;
  readonly afterStage?: (index: number) => void | Promise<void>;
  readonly beforeJournal?: () => void | Promise<void>;
  readonly afterJournal?: () => void | Promise<void>;
  readonly beforeOutputPromotion?: (index: number) => void | Promise<void>;
  readonly beforeLockPromotion?: () => void | Promise<void>;
  readonly beforeRollback?: (index: number) => void | Promise<void>;
  readonly beforeCleanup?: (index: number) => void | Promise<void>;
}
export interface ConsumerInstallResult {
  readonly operation: "install" | "sync" | "adopt";
  readonly packages: readonly string[];
  readonly profiles: readonly string[];
  readonly destinations: readonly string[];
  readonly omittedOptional: readonly string[];
  readonly lockDigest: string;
  readonly writtenOutputs: number;
}

interface Staged {
  readonly destination: string;
  readonly relativeDestination: string;
  readonly stage: string;
  readonly backup: string;
  readonly bytes: Uint8Array;
  readonly stageHandle: FileHandle;
  readonly stageIdentity: ReturnType<typeof identity>;
  readonly expectedKind: "absent" | "file";
  readonly expectedIdentity?: ReturnType<typeof identity>;
  readonly expectedDigest?: string;
  readonly parentPath: string;
  readonly parentIdentity: ReturnType<typeof identity>;
  readonly parentHandle: FileHandle;
  promoted: boolean;
  backedUp: boolean;
}

function sameDirectoryAuthority(left: ReturnType<typeof identity>, right: ReturnType<typeof identity>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}
async function verifyDirectory(path: string, expected: ReturnType<typeof identity>, handle: FileHandle): Promise<void> {
  const named = await lstat(path).catch(() => undefined), opened = await handle.stat().catch(() => undefined);
  if (named === undefined || opened === undefined || named.isSymbolicLink() || !named.isDirectory() || !opened.isDirectory() || !sameDirectoryAuthority(identity(named), expected) || !sameDirectoryAuthority(identity(opened), expected)) fail({ operation: "install", domain: "transaction" }, "CONSUMER_PARENT_CHANGED", "Consumer destination parent authority changed.");
}
async function ensureParent(
  authority: ConsumerPlanInternals["lockParentAuthority"],
  created: Map<string, ReturnType<typeof identity>>,
  retainedHandles: FileHandle[],
): Promise<{ readonly path: string; readonly identity: ReturnType<typeof identity>; readonly handle: FileHandle }> {
  await verifyDirectory(authority.nearestPath, authority.nearestIdentity, authority.nearestHandle);
  for (const path of authority.missingDirectories) {
    const existingOwned = created.get(path);
    if (existingOwned !== undefined) {
      const stat = await lstat(path).catch(() => undefined);
      if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory() || !sameDirectoryAuthority(identity(stat), existingOwned)) fail({ operation: "install", domain: "transaction" }, "CONSUMER_PARENT_CHANGED", "Consumer-created destination parent changed.");
      continue;
    }
    if (await lstat(path).catch(() => undefined) !== undefined) fail({ operation: "install", domain: "transaction" }, "CONSUMER_PARENT_CHANGED", "A missing consumer destination parent appeared after planning.");
    await mkdir(path, { mode: 0o700 });
    const createdStat = await lstat(path);
    if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) fail({ operation: "install", domain: "transaction" }, "CONSUMER_PARENT_CHANGED", "Consumer destination parent creation was unsafe.");
    created.set(path, identity(createdStat));
  }
  const parentPath = authority.missingDirectories.at(-1) ?? authority.nearestPath;
  if (parentPath === authority.nearestPath) return { path: parentPath, identity: authority.nearestIdentity, handle: authority.nearestHandle };
  const parentHandle = await open(parentPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)); retainedHandles.push(parentHandle);
  const parentStat = await parentHandle.stat();
  if (!parentStat.isDirectory()) fail({ operation: "install", domain: "transaction" }, "CONSUMER_PARENT_CHANGED", "Consumer destination parent is unsafe after creation.");
  return { path: parentPath, identity: identity(parentStat), handle: parentHandle };
}

function sha(bytes: Uint8Array): string { return `sha256:${computeRawSha256(bytes)}`; }
async function verifyOne(internals: ConsumerPlanInternals, index: number): Promise<void> {
  const output = internals.outputs[index]!;
  const current = await lstat(output.absoluteDestination).catch(() => undefined);
  if (output.snapshot.kind === "absent") {
    if (current !== undefined) fail({ operation: "install", domain: "transaction" }, "CONSUMER_DESTINATION_CHANGED", `Destination '${output.destination}' appeared after planning.`, output.destination);
    return;
  }
  if (current === undefined || current.isSymbolicLink() || !current.isFile() || output.snapshot.identity === undefined || !sameFileIdentity(identity(current), output.snapshot.identity) || output.handle === undefined) fail({ operation: "install", domain: "transaction" }, "CONSUMER_DESTINATION_CHANGED", `Destination '${output.destination}' changed after planning.`, output.destination);
  const opened = await output.handle.stat();
  if (!sameFileIdentity(identity(opened), output.snapshot.identity)) fail({ operation: "install", domain: "transaction" }, "CONSUMER_DESTINATION_CHANGED", `Opened destination '${output.destination}' changed.`, output.destination);
  const bytes = await readExactBuffer(output.handle, opened.size, 0, { operation: "install", domain: "transaction" }, 8 * 1_048_576);
  if (sha(bytes) !== output.snapshot.digest) fail({ operation: "install", domain: "transaction" }, "CONSUMER_DESTINATION_CHANGED", `Destination '${output.destination}' bytes changed.`, output.destination);
}
async function verifyStage(item: Staged): Promise<void> {
  const stat = await lstat(item.stage).catch(() => undefined), opened = await item.stageHandle.stat().catch(() => undefined);
  if (stat === undefined || opened === undefined || stat.isSymbolicLink() || !stat.isFile() || !opened.isFile() || !sameFileIdentity(identity(stat), item.stageIdentity) || !sameFileIdentity(identity(opened), item.stageIdentity) || stat.size !== item.bytes.byteLength || sha(await readExactBuffer(item.stageHandle, opened.size, 0, { operation: "install", domain: "transaction" }, 8 * 1_048_576)) !== sha(item.bytes)) fail({ operation: "install", domain: "transaction" }, "CONSUMER_STAGE_CHANGED", "Consumer staged output changed before promotion.", item.relativeDestination);
}
async function removeOwnedStage(item: Staged): Promise<boolean> {
  const stat = await lstat(item.stage).catch(() => undefined);
  if (stat === undefined) return true;
  if (stat.isSymbolicLink() || !stat.isFile() || !sameFileIdentity(identity(stat), item.stageIdentity) || sha(await readFile(item.stage)) !== sha(item.bytes)) return false;
  await rm(item.stage); return true;
}
async function verifyTransactionState(internals: ConsumerPlanInternals, staged: readonly Staged[]): Promise<void> {
  for (let index = 0; index < internals.outputs.length; index++) {
    const output = internals.outputs[index]!, item = staged.find((entry) => entry.relativeDestination === output.destination);
    if (item?.promoted === true) {
      const stat = await lstat(item.destination).catch(() => undefined);
      if (stat === undefined || stat.isSymbolicLink() || !stat.isFile() || sha(await readFile(item.destination)) !== sha(item.bytes)) fail({ operation: "install", domain: "transaction" }, "CONSUMER_DESTINATION_CHANGED", `Promoted destination '${item.relativeDestination}' changed.`, item.relativeDestination);
    } else await verifyOne(internals, index);
  }
  for (const item of staged) {
    if (!item.promoted) await verifyStage(item);
    await verifyDirectory(item.parentPath, item.parentIdentity, item.parentHandle);
  }
}
async function removeOwned(path: string, expectedDigest: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => undefined); if (stat === undefined) return true;
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  const bytes = await readFile(path); if (sha(bytes) !== expectedDigest) return false;
  await rm(path); return true;
}
async function verifyBackup(item: Staged): Promise<void> {
  if (!item.backedUp || item.expectedIdentity === undefined || item.expectedDigest === undefined) return;
  const stat = await lstat(item.backup).catch(() => undefined);
  const current = stat === undefined ? undefined : identity(stat);
  if (stat === undefined || current === undefined || stat.isSymbolicLink() || !stat.isFile() || current.dev !== item.expectedIdentity.dev || current.ino !== item.expectedIdentity.ino || current.mode !== item.expectedIdentity.mode || current.size !== item.expectedIdentity.size || sha(await readFile(item.backup)) !== item.expectedDigest) fail({ operation: "install", domain: "transaction" }, "CONSUMER_BACKUP_CHANGED", "Consumer transaction backup changed.", item.relativeDestination);
}
function result(plan: ConsumerPlanSummary, writtenOutputs: number): ConsumerInstallResult { return Object.freeze({ operation: plan.operation, packages: plan.packages, profiles: plan.profiles, destinations: Object.freeze(plan.outputs.map((entry) => entry.destination)), omittedOptional: plan.omittedOptional, lockDigest: plan.lockDigest, writtenOutputs }); }

async function executeAdoption(plan: ConsumerPlanSummary, internals: ConsumerPlanInternals, hooks: ConsumerTransactionHooks): Promise<ConsumerInstallResult> {
  if (internals.adoptionProjectBytes === undefined) throw new Error("Adoption plan lacks private canonical bytes.");
  const nextFiles = new Map(internals.project.canonicalFiles);
  nextFiles.set(".tfsb/project.toml", internals.adoptionProjectBytes);
  nextFiles.set(".tfsb/brand.lock.json", Buffer.from(serializeConsumerBrandLock(internals.nextLock), "utf8"));
  await executeCanonicalTransaction({
    root: internals.project.root,
    expectedSnapshot: internals.project.snapshot,
    nextFiles,
    operation: "install",
    verifyExternalState: async () => {
      await revalidateConsumerSources(internals.sources);
      for (let index = 0; index < internals.outputs.length; index++) await verifyOne(internals, index);
    },
    hooks: {
      beforeStageCreate: () => hooks.beforeStage?.(0),
      afterStageWrite: () => hooks.afterStage?.(0),
      beforePromotion: () => hooks.beforeLockPromotion?.(),
    },
  });
  return result(plan, 0);
}

async function executeOutputs(plan: ConsumerPlanSummary, internals: ConsumerPlanInternals, hooks: ConsumerTransactionHooks): Promise<ConsumerInstallResult> {
  return withCanonicalMutationLock(internals.project.root, "install", async () => {
    const residue = await findRecoveryResidue(internals.project.root);
    if (residue.length > 0) fail({ operation: "install", domain: "transaction" }, "TFSB_RECOVERY_REQUIRED", `Recovery residue requires manual inspection: ${residue.join(", ")}.`, residue[0]);
    const transactionOutputs = internals.outputs.filter((output) => output.snapshot.kind === "absent" || output.snapshot.digest !== sha(output.bytes));
    await verifyLoadedProjectSnapshot(internals.project, "install"); await revalidateConsumerSources(internals.sources);
    for (let index = 0; index < internals.outputs.length; index++) await verifyOne(internals, index);
    if (transactionOutputs.length === 0 && internals.oldLock?.lockDigest === internals.nextLock.lockDigest) return result(plan, 0);
    const token = randomUUID().replace(/-/g, ""), staged: Staged[] = [], createdDirectories = new Map<string, ReturnType<typeof identity>>(), retainedParentHandles: FileHandle[] = [];
    const lockDestination = join(internals.project.root, ".tfsb", "brand.lock.json");
    const lockBytes = Buffer.from(serializeConsumerBrandLock(internals.nextLock), "utf8");
    const journal = join(internals.project.root, `.tfsb-consumer-transaction-${token}.json`);
    let journalBytes = Buffer.alloc(0), journalWritten = false, journalHandle: FileHandle | undefined, journalIdentity: ReturnType<typeof identity> | undefined, lockPromoted = false;
    const verifyJournal = async (): Promise<void> => {
      const named = await lstat(journal).catch(() => undefined), opened = await journalHandle?.stat().catch(() => undefined);
      if (named === undefined || opened === undefined || journalIdentity === undefined || named.isSymbolicLink() || !named.isFile() || !sameFileIdentity(identity(named), journalIdentity) || !sameFileIdentity(identity(opened), journalIdentity) || sha(await readExactBuffer(journalHandle!, opened.size, 0, { operation: "install", domain: "transaction" }, 1_048_576)) !== sha(journalBytes)) fail({ operation: "install", domain: "transaction" }, "CONSUMER_JOURNAL_CHANGED", "Consumer transaction journal changed.");
    };
    try {
      for (const [index, output] of transactionOutputs.entries()) {
        await hooks.beforeStage?.(index); const parentAuthority = await ensureParent(output.parentAuthority, createdDirectories, retainedParentHandles); const parent = parentAuthority.path;
        const stage = join(parent, `.${basename(output.absoluteDestination)}.tfsb-consumer-stage-${token}`), backup = join(parent, `.${basename(output.absoluteDestination)}.tfsb-consumer-backup-${token}`);
        await durableWrite(stage, output.bytes); await syncPath(parent);
        const stageHandle = await open(stage, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), stageIdentity = identity(await stageHandle.stat());
        staged.push({ destination: output.absoluteDestination, relativeDestination: output.destination, stage, backup, bytes: Buffer.from(output.bytes), stageHandle, stageIdentity, expectedKind: output.snapshot.kind, ...(output.snapshot.identity === undefined ? {} : { expectedIdentity: output.snapshot.identity, expectedDigest: output.snapshot.digest }), parentPath: parent, parentIdentity: parentAuthority.identity, parentHandle: parentAuthority.handle, promoted: false, backedUp: false });
        await hooks.afterStage?.(index);
      }
      const lockParentAuthority = await ensureParent(internals.lockParentAuthority, createdDirectories, retainedParentHandles);
      const lockStage = join(dirname(lockDestination), `.brand.lock.json.tfsb-consumer-stage-${token}`), lockBackup = join(dirname(lockDestination), `.brand.lock.json.tfsb-consumer-backup-${token}`);
      await hooks.beforeStage?.(staged.length); await durableWrite(lockStage, lockBytes); await syncPath(dirname(lockDestination));
      const lockStageHandle = await open(lockStage, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), lockStageIdentity = identity(await lockStageHandle.stat());
      const oldLockSnapshot = internals.project.snapshot.files.get(".tfsb/brand.lock.json");
      staged.push({ destination: lockDestination, relativeDestination: ".tfsb/brand.lock.json", stage: lockStage, backup: lockBackup, bytes: lockBytes, stageHandle: lockStageHandle, stageIdentity: lockStageIdentity, expectedKind: internals.oldLock === undefined ? "absent" : "file", ...(oldLockSnapshot === undefined ? {} : { expectedIdentity: oldLockSnapshot, expectedDigest: oldLockSnapshot.digest }), parentPath: lockParentAuthority.path, parentIdentity: lockParentAuthority.identity, parentHandle: lockParentAuthority.handle, promoted: false, backedUp: false }); await hooks.afterStage?.(staged.length - 1);
      await hooks.beforeJournal?.();
      journalBytes = Buffer.from(`${encodeCanonicalJson({ schema: "tfsb.consumer-transaction", schemaVersion: 1, entries: staged.map((entry) => ({ destination: entry.relativeDestination, stage: basename(entry.stage), backup: basename(entry.backup) })), lockLast: true })}\n`, "utf8");
      await durableWrite(journal, journalBytes); journalWritten = true; journalHandle = await open(journal, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); journalIdentity = identity(await journalHandle.stat()); await syncPath(internals.project.root); await hooks.afterJournal?.();
      const ignoredCanonicalFiles = [relative(internals.project.root, lockStage).split(sep).join("/")];
      for (let index = 0; index < transactionOutputs.length; index++) {
        await hooks.beforeOutputPromotion?.(index); await verifyLoadedProjectSnapshot(internals.project, "install", ignoredCanonicalFiles); await revalidateConsumerSources(internals.sources); await verifyTransactionState(internals, staged);
        await verifyJournal();
        const item = staged[index]!;
        if (item.expectedKind === "file") { await rename(item.destination, item.backup); item.backedUp = true; await verifyBackup(item); }
        await link(item.stage, item.destination); await rm(item.stage); item.promoted = true; await syncPath(dirname(item.destination));
      }
      await hooks.beforeLockPromotion?.(); await verifyLoadedProjectSnapshot(internals.project, "install", ignoredCanonicalFiles); await revalidateConsumerSources(internals.sources); await verifyTransactionState(internals, staged);
      await verifyJournal();
      const lock = staged.at(-1)!;
      if (lock.expectedKind === "file") { await rename(lock.destination, lock.backup); lock.backedUp = true; await verifyBackup(lock); }
      await link(lock.stage, lock.destination); await rm(lock.stage); lock.promoted = true; lockPromoted = true; await syncPath(dirname(lock.destination));
    } catch (error) {
      let recoveryRequired = false;
      for (let index = staged.length - 1; index >= 0; index--) {
        const item = staged[index]!;
        try {
          await hooks.beforeRollback?.(index);
          if (item.promoted && !(await removeOwned(item.destination, sha(item.bytes)))) { recoveryRequired = true; continue; }
          if (item.backedUp) {
            const current = await lstat(item.destination).catch(() => undefined);
            if (current !== undefined) { recoveryRequired = true; continue; }
            await verifyBackup(item);
            await rename(item.backup, item.destination); item.backedUp = false;
          }
          if (!(await removeOwnedStage(item))) { recoveryRequired = true; continue; }
          await syncPath(dirname(item.destination));
          await item.stageHandle.close();
        } catch { recoveryRequired = true; }
      }
      for (const [path, expected] of [...createdDirectories].reverse()) {
        try { const stat = await lstat(path).catch(() => undefined); if (stat !== undefined && sameDirectoryAuthority(identity(stat), expected)) await rmdir(path); else if (stat !== undefined) recoveryRequired = true; }
        catch { recoveryRequired = true; }
      }
      for (const item of staged) await item.stageHandle.close().catch(() => { recoveryRequired = true; });
      for (const handle of retainedParentHandles) await handle.close().catch(() => { recoveryRequired = true; });
      if (journalWritten) await verifyJournal().catch(() => { recoveryRequired = true; });
      await journalHandle?.close().catch(() => { recoveryRequired = true; });
      if (!recoveryRequired && journalWritten) { await rm(journal, { force: true }); await syncPath(internals.project.root); }
      const priorCode = error instanceof DiagnosticError ? ` after ${error.diagnostic.code}` : "";
      throw new DiagnosticError({ code: recoveryRequired ? "CONSUMER_RECOVERY_REQUIRED" : "CONSUMER_TRANSACTION_ROLLED_BACK", operation: "install", domain: "transaction", message: recoveryRequired ? `Consumer transaction failed${priorCode} and retained recovery residue.` : `Consumer transaction failed${priorCode} and was rolled back.`, ...(error instanceof DiagnosticError && error.diagnostic.location !== undefined ? { location: error.diagnostic.location } : {}) });
    }
    let cleanupFailed = false;
    for (const [index, item] of staged.entries()) {
      try { await hooks.beforeCleanup?.(index); if (item.backedUp) { await verifyBackup(item); await rm(item.backup); } if (!(await removeOwnedStage(item))) throw new Error("stage ownership changed"); await item.stageHandle.close(); await syncPath(dirname(item.destination)); }
      catch { cleanupFailed = true; }
    }
    for (const handle of retainedParentHandles) await handle.close().catch(() => { cleanupFailed = true; });
    if (journalWritten) await verifyJournal().catch(() => { cleanupFailed = true; });
    await journalHandle?.close().catch(() => { cleanupFailed = true; });
    if (!cleanupFailed) { await rm(journal, { force: true }); await syncPath(internals.project.root); }
    if (cleanupFailed || !lockPromoted) fail({ operation: "install", domain: "transaction" }, "CONSUMER_RECOVERY_REQUIRED", "Consumer transaction completed promotion but retained recovery residue.");
    return result(plan, transactionOutputs.length);
  });
}

async function execute(plan: ConsumerPlanSummary, hooks: ConsumerTransactionHooks = {}): Promise<ConsumerInstallResult> {
  const internals = getConsumerPlanInternals(plan);
  if (internals === undefined || internals.disposed || internals.executed || !Object.isFrozen(plan)) fail({ operation: "install", domain: "transaction" }, "CONSUMER_INVALID_PLAN", "Consumer apply requires an authentic unused plan.");
  internals.executed = true;
  try { return internals.operation === "adopt" ? await executeAdoption(plan, internals, hooks) : await executeOutputs(plan, internals, hooks); }
  finally { await disposeConsumerPlan(plan); }
}

export async function executeConsumerInstallPlan(plan: ConsumerInstallPlan, hooks?: ConsumerTransactionHooks): Promise<ConsumerInstallResult> { return execute(plan, hooks); }
export async function executeConsumerSyncPlan(plan: ConsumerSyncPlan, hooks?: ConsumerTransactionHooks): Promise<ConsumerInstallResult> { return execute(plan, hooks); }
export async function executeConsumerAdoptionPlan(plan: ConsumerAdoptionPlan, hooks?: ConsumerTransactionHooks): Promise<ConsumerInstallResult> { return execute(plan, hooks); }
