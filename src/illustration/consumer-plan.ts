import { lstat } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";

import { computeSha256 } from "../digests.js";
import {
  executeManagedOutputTransaction, type ManagedOutput, type ManagedOutputParentAuthority,
  type ManagedOutputTransactionHooks,
} from "../managed-output-transaction.js";
import { canonicalJson } from "../service-protocol/canonical-json.js";
import { findRecoveryResidue } from "../transaction.js";
import {
  createIllustrationConsumerLock, parseIllustrationConsumerLock, parseIllustrationConsumerProfile,
  serializeIllustrationConsumerLock, type IllustrationConsumerLockV1,
} from "./carrier-v1.js";
import {
  disposeIllustrationSource, getIllustrationPayload, isIllustrationSourceDirectory, revalidateIllustrationSource,
  verifyIllustrationSource, type VerifiedIllustrationSource,
} from "./carrier-source.js";
import {
  closeIllustrationDirectories, illustrationAbsolutePath, retainIllustrationDirectories,
  retainIllustrationFile, verifyIllustrationDirectories, verifyIllustrationFile,
  type RetainedIllustrationDirectory, type RetainedIllustrationFile,
} from "./retained-files.js";

export const ILLUSTRATION_PROFILE_FILENAME = ".tfsb-illustration-profile.json";
export const ILLUSTRATION_LOCK_FILENAME = ".tfsb-illustration.lock.json";

export class IllustrationPlanError extends Error {
  constructor(readonly code: string) { super("Illustration consumer planning failed."); this.name = "IllustrationPlanError"; }
}

export interface IllustrationInstallPlan {
  readonly schema: "tfsb.illustration-install-plan";
  readonly schemaVersion: 1;
  readonly operation: "install" | "sync";
  readonly packageId: string;
  readonly profileDigest: string;
  readonly manifestDigest: string;
  readonly lockDigest: string;
  readonly outputs: readonly { readonly derivativeId: string; readonly destination: string; readonly sha256: string }[];
  readonly planDigest: string;
}

interface State {
  readonly root: string;
  readonly source: VerifiedIllustrationSource;
  readonly directories: RetainedIllustrationDirectory[][];
  readonly files: RetainedIllustrationFile[];
  readonly profile: RetainedIllustrationFile;
  readonly oldLock?: RetainedIllustrationFile;
  readonly outputs: ManagedOutput[];
  readonly lock: ManagedOutput;
  disposed: boolean;
  executed: boolean;
  running: boolean;
}
const states = new WeakMap<IllustrationInstallPlan, State>();
function fail(code: string): never { throw new IllustrationPlanError(code); }
async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; fail("ILLUSTRATION_PATH_UNSAFE"); }
}

async function parentAuthority(root: string, destination: string, state: Pick<State, "directories">): Promise<ManagedOutputParentAuthority> {
  const parent = dirname(join(root, destination));
  const suffix = relative(root, parent);
  if (suffix === ".." || suffix.startsWith(`..${sep}`)) fail("ILLUSTRATION_PATH_UNSAFE");
  let nearest = root;
  const missing: string[] = [];
  for (const component of suffix.split(sep).filter(Boolean)) {
    const path = join(missing.at(-1) ?? nearest, component);
    if (missing.length) { missing.push(path); continue; }
    const stat = await optionalLstat(path);
    if (!stat) missing.push(path);
    else if (stat.isDirectory() && !stat.isSymbolicLink()) nearest = path;
    else fail("ILLUSTRATION_PATH_UNSAFE");
  }
  const chain = [...await retainIllustrationDirectories(nearest)];
  state.directories.push(chain);
  const retained = chain.at(-1)!;
  return { nearestPath: nearest, nearestIdentity: retained.identity, nearestHandle: retained.handle, missingDirectories: missing };
}

function snapshot(file?: RetainedIllustrationFile): ManagedOutput["snapshot"] {
  return file ? { kind: "file", identity: file.identity, digest: file.sha256 } : { kind: "absent" };
}

async function verifyState(state: State): Promise<void> {
  for (const chain of state.directories) await verifyIllustrationDirectories(chain);
  await verifyIllustrationFile(state.profile);
  if (state.oldLock) await verifyIllustrationFile(state.oldLock);
  else if (await optionalLstat(join(state.root, ILLUSTRATION_LOCK_FILENAME))) fail("ILLUSTRATION_LOCK_CHANGED");
}

/** No adoption, deletion, remote lookup, or provider invocation in v1. */
export async function planIllustrationInstall(options: { readonly root: string; readonly sourceDirectory: string; readonly operation?: "install" | "sync" }): Promise<IllustrationInstallPlan> {
  const operation = options.operation ?? "install";
  if (operation !== "install" && operation !== "sync") fail("ILLUSTRATION_INVALID_OPERATION");
  const root = illustrationAbsolutePath(options.root);
  const sourceRoot = illustrationAbsolutePath(options.sourceDirectory);
  const directories: RetainedIllustrationDirectory[][] = [];
  const files: RetainedIllustrationFile[] = [];
  let source: VerifiedIllustrationSource | undefined;
  try {
    directories.push([...await retainIllustrationDirectories(root)]);
    if ((await findRecoveryResidue(root)).length > 0) fail("ILLUSTRATION_RECOVERY_REQUIRED");
    const profile = await retainIllustrationFile(join(root, ILLUSTRATION_PROFILE_FILENAME), 262144); files.push(profile);
    const parsedProfile = parseIllustrationConsumerProfile(profile.bytes);
    const lockStat = await optionalLstat(join(root, ILLUSTRATION_LOCK_FILENAME));
    const oldLockFile = lockStat ? await retainIllustrationFile(join(root, ILLUSTRATION_LOCK_FILENAME), 262144) : undefined;
    if (oldLockFile) files.push(oldLockFile);
    const oldLock: IllustrationConsumerLockV1 | undefined = oldLockFile ? parseIllustrationConsumerLock(oldLockFile.bytes) : undefined;
    if (operation === "sync" && !oldLock) fail("ILLUSTRATION_LOCK_MISSING");
    if (oldLock && (oldLock.packageId !== parsedProfile.packageId || oldLock.illustrationId !== parsedProfile.illustrationId)) fail("ILLUSTRATION_PROFILE_IDENTITY_CHANGED");
    if (oldLock && oldLock.profileDigest !== parsedProfile.profileDigest && operation !== "sync") fail("ILLUSTRATION_USE_SYNC");
    if (oldLock?.mappings.some(old => !parsedProfile.mappings.some(mapping => mapping.derivativeId === old.derivativeId && mapping.destination === old.destination))) fail("ILLUSTRATION_MAPPING_REMOVAL_UNSUPPORTED");
    source = await verifyIllustrationSource(sourceRoot);
    if (source.manifest.packageId !== parsedProfile.packageId || source.manifest.illustrationId !== parsedProfile.illustrationId) fail("ILLUSTRATION_SOURCE_IDENTITY_MISMATCH");
    if (oldLock && source.manifest.revision < oldLock.carrierRevision) fail("ILLUSTRATION_SOURCE_ROLLBACK");
    if (oldLock && source.manifest.revision === oldLock.carrierRevision && source.manifest.manifestDigest !== oldLock.manifestDigest) fail("ILLUSTRATION_CARRIER_REVISION_REUSED");
    if (operation === "install" && oldLock && oldLock.manifestDigest !== source.manifest.manifestDigest) fail("ILLUSTRATION_USE_SYNC");
    const outputs: ManagedOutput[] = [];
    const lockMappings = [];
    for (const mapping of parsedProfile.mappings) {
      const item = source.manifest.derivatives.find(row => row.id === mapping.derivativeId);
      if (!item) fail("ILLUSTRATION_DERIVATIVE_MISSING");
      if (extname(mapping.destination) !== (item.mime === "image/png" ? ".png" : ".webp")) fail("ILLUSTRATION_DESTINATION_TYPE_MISMATCH");
      const authority = await parentAuthority(root, mapping.destination, { directories });
      if (isIllustrationSourceDirectory(source, authority.nearestIdentity)) fail("ILLUSTRATION_SOURCE_DESTINATION_COLLISION");
      const path = join(root, mapping.destination);
      if (path === sourceRoot || path.startsWith(sourceRoot + sep)) fail("ILLUSTRATION_SOURCE_DESTINATION_COLLISION");
      const observed = await optionalLstat(path);
      const old = oldLock?.mappings.find(row => row.derivativeId === mapping.derivativeId && row.destination === mapping.destination);
      if (old && !observed) fail("ILLUSTRATION_MANAGED_DRIFT");
      if (observed && !old) fail("ILLUSTRATION_DESTINATION_COLLISION");
      const retained = observed ? await retainIllustrationFile(path, 32 * 1048576) : undefined;
      if (retained) files.push(retained);
      if (retained && retained.sha256 !== old!.sha256) fail("ILLUSTRATION_MANAGED_DRIFT");
      const bytes = getIllustrationPayload(source, mapping.derivativeId);
      outputs.push({ destination: mapping.destination, absoluteDestination: path, bytes, snapshot: snapshot(retained),
        ...(retained ? { handle: retained.handle } : {}), parentAuthority: authority, maxBytes: 32 * 1048576 });
      lockMappings.push({ derivativeId: mapping.derivativeId, destination: mapping.destination, recipeDigest: item.recipeDigest,
        sha256: item.sha256, mime: item.mime, byteLength: item.byteLength });
    }
    const nextLock = createIllustrationConsumerLock({ packageId: source.manifest.packageId, illustrationId: source.manifest.illustrationId,
      carrierRevision: source.manifest.revision, profileDigest: parsedProfile.profileDigest, manifestDigest: source.manifest.manifestDigest,
      recordDigest: source.manifest.recordDigest, mappings: lockMappings });
    const lock: ManagedOutput = { destination: ILLUSTRATION_LOCK_FILENAME, absoluteDestination: join(root, ILLUSTRATION_LOCK_FILENAME),
      bytes: Buffer.from(serializeIllustrationConsumerLock(nextLock)), snapshot: snapshot(oldLockFile),
      ...(oldLockFile ? { handle: oldLockFile.handle } : {}), parentAuthority: await parentAuthority(root, ILLUSTRATION_LOCK_FILENAME, { directories }), maxBytes: 262144 };
    const state: State = { root, source, directories, files, profile, ...(oldLockFile ? { oldLock: oldLockFile } : {}), outputs, lock, disposed: false, executed: false, running: false };
    await verifyState(state); await revalidateIllustrationSource(source);
    const summary = { schema: "tfsb.illustration-install-plan" as const, schemaVersion: 1 as const, operation,
      packageId: source.manifest.packageId, profileDigest: parsedProfile.profileDigest,
      manifestDigest: source.manifest.manifestDigest, lockDigest: nextLock.lockDigest,
      outputs: Object.freeze(outputs.map((output, index) => Object.freeze({ derivativeId: parsedProfile.mappings[index]!.derivativeId,
        destination: output.destination, sha256: computeSha256(output.bytes) }))) };
    const plan = Object.freeze({ ...summary, planDigest: computeSha256(Buffer.from(`tfsb.illustration-install-plan-v1\n${canonicalJson(summary)}`)) });
    states.set(plan, state);
    return plan;
  } catch (error) {
    for (const file of files) await file.handle.close().catch(() => undefined);
    for (const chain of directories) await closeIllustrationDirectories(chain);
    if (source) await disposeIllustrationSource(source);
    if (error instanceof IllustrationPlanError) throw error;
    fail("ILLUSTRATION_PLAN_INPUT_INVALID");
  }
}

/** Hooks are unsupported fault-injection seams for tests, not a stable application API. */
export async function executeIllustrationInstallPlan(plan: IllustrationInstallPlan, hooks?: ManagedOutputTransactionHooks): Promise<{ readonly writtenOutputs: number; readonly lockDigest: string; readonly changed: boolean }> {
  const state = states.get(plan);
  if (!state || state.disposed || state.executed || !Object.isFrozen(plan)) fail("ILLUSTRATION_INVALID_PLAN");
  state.executed = true;
  state.running = true;
  try {
    const result = await executeManagedOutputTransaction({ root: state.root, namespace: "illustration", outputs: state.outputs, lock: state.lock,
      verifySource: () => revalidateIllustrationSource(state.source), verifyProject: () => verifyState(state), ...(hooks ? { hooks } : {}) });
    const changed = result.writtenOutputs > 0 || state.oldLock?.sha256 !== computeSha256(state.lock.bytes);
    return Object.freeze({ writtenOutputs: result.writtenOutputs, lockDigest: plan.lockDigest, changed });
  } finally { state.running = false; await disposeIllustrationPlan(plan); }
}

export async function disposeIllustrationPlan(plan: IllustrationInstallPlan): Promise<void> {
  const state = states.get(plan);
  if (!state || state.disposed) return;
  if (state.running) fail("ILLUSTRATION_PLAN_ACTIVE");
  state.disposed = true;
  for (const file of state.files) await file.handle.close().catch(() => undefined);
  for (const chain of state.directories) await closeIllustrationDirectories(chain);
  await disposeIllustrationSource(state.source);
  state.outputs.length = 0; state.files.length = 0; state.directories.length = 0;
}
