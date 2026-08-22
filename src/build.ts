import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import {
  durableWrite,
  sameFlatDirectorySnapshot,
  snapshotFlatDirectory,
  syncPath,
  type FlatDirectorySnapshot,
} from "./filesystem.js";
import {
  enforceMutationAssetLimit,
  loadCanonicalProject,
  verifyLoadedProjectSnapshot,
  type LoadedProject,
} from "./project.js";
import { compareUtf8 } from "./provenance.js";
import {
  BUILD_RECEIPT_FILENAME,
  BUILD_RECEIPT_MAX_BYTES,
  createBuildReceipt,
  parseBuildReceipt,
  receiptOwnsProject,
  serializeBuildReceipt,
  type BuildReceipt,
} from "./receipt.js";
import { resolveConfinedPath } from "./root.js";
import { withCanonicalMutationLock } from "./transaction.js";

const buildPlanBrand: unique symbol = Symbol("tfsb-build-plan");

export interface BuildPlan {
  readonly buildDirectory: string;
  readonly outputs: readonly BuildPlanOutput[];
  readonly receipt: BuildReceipt;
  readonly replacingExisting: boolean;
  readonly [buildPlanBrand]: true;
}

export interface BuildPlanOutput {
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}

interface BuildPlanInternals {
  readonly project: LoadedProject;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly targetSnapshot: FlatDirectorySnapshot;
}

const buildPlanInternals = new WeakMap<BuildPlan, BuildPlanInternals>();

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export interface BuildTestHooks {
  readonly afterStage?: () => void | Promise<void>;
  readonly afterBackup?: () => void | Promise<void>;
  readonly afterPromote?: () => void | Promise<void>;
}

export interface BuildInspection {
  readonly receipt?: BuildReceipt;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly different: readonly string[];
}

interface BuildInspectionSnapshot {
  readonly inspection: BuildInspection;
  readonly snapshot: FlatDirectorySnapshot;
}

function context(operation: DiagnosticContext["operation"] = "build"): DiagnosticContext {
  return { operation, domain: "filesystem" };
}

export async function inspectBuildSnapshot(
  project: LoadedProject,
  operation: DiagnosticContext["operation"] = "build",
): Promise<BuildInspectionSnapshot> {
  const ctx = context(operation);
  const snapshot = await snapshotFlatDirectory(
    project.buildDirectory,
    ctx,
    "BUILD_UNSAFE_CONTENT",
    "Build target must be an absent or flat non-symlink directory of regular files.",
    130,
  );
  if (snapshot.kind === "absent") {
    return {
      snapshot,
      inspection: { missing: [...project.outputs.keys()].sort(compareUtf8), extra: [], different: [] },
    };
  }
  const marker = snapshot.files.get(BUILD_RECEIPT_FILENAME);
  if (marker === undefined || marker.kind !== "file" || marker.size > BUILD_RECEIPT_MAX_BYTES) {
    fail(ctx, "BUILD_UNOWNED_DIRECTORY", "Existing build directory is not proven to be TFSB-owned.", project.project.buildDirectory);
  }
  const receiptState = parseBuildReceipt(Buffer.from(marker.bytes).toString("utf8"));
  if ((receiptState.status !== "v2" && receiptState.status !== "v3") || !receiptOwnsProject(receiptState.receipt, project.project.buildDirectory)) {
    fail(ctx, "BUILD_UNOWNED_DIRECTORY", "Existing build directory is not proven to be TFSB-owned.", project.project.buildDirectory);
  }
  const expected = new Set(project.outputs.keys());
  const actual = [...snapshot.files.keys()].filter((name) => name !== BUILD_RECEIPT_FILENAME).sort(compareUtf8);
  const missing = [...expected].filter((name) => !snapshot.files.has(name)).sort(compareUtf8);
  const extra = actual.filter((name) => !expected.has(name)).sort(compareUtf8);
  const different: string[] = [];
  for (const [name, bytes] of [...project.outputs].sort(([left], [right]) => compareUtf8(left, right))) {
    const current = snapshot.files.get(name);
    if (current !== undefined && current.kind === "file" && !Buffer.from(current.bytes).equals(Buffer.from(bytes))) {
      different.push(name);
    }
  }
  return { snapshot, inspection: { receipt: receiptState.receipt, missing, extra, different } };
}

export async function inspectBuild(
  project: LoadedProject,
  operation: DiagnosticContext["operation"] = "build",
): Promise<BuildInspection> {
  return (await inspectBuildSnapshot(project, operation)).inspection;
}

export async function planBuild(root: string): Promise<BuildPlan> {
  const project = await loadCanonicalProject(root, "build");
  enforceMutationAssetLimit(project, "build");
  const target = await inspectBuildSnapshot(project);
  await verifyLoadedProjectSnapshot(project, "build");
  const receipt = createBuildReceipt(project);
  const files = new Map(project.outputs);
  files.set(BUILD_RECEIPT_FILENAME, serializeBuildReceipt(receipt));
  const outputs = Object.freeze([...project.outputs].sort(([left], [right]) => compareUtf8(left, right)).map(([filename, bytes]) => Object.freeze({ filename, size: bytes.byteLength, sha256: receipt.outputs[filename]! })));
  const publicReceipt = deepFreeze(receipt);
  const plan = Object.freeze({
    buildDirectory: project.project.buildDirectory,
    outputs,
    receipt: publicReceipt,
    replacingExisting: target.snapshot.kind === "directory",
    [buildPlanBrand]: true as const,
  });
  buildPlanInternals.set(plan, { project, files: new Map(files), targetSnapshot: target.snapshot });
  return plan;
}

export async function executeBuild(plan: BuildPlan, hooks: BuildTestHooks = {}): Promise<void> {
  const internals = buildPlanInternals.get(plan);
  if (internals === undefined || !Object.isFrozen(plan) || !Object.isFrozen(plan.outputs)) {
    fail(context(), "BUILD_INVALID_PLAN", "Build plan is not authentic.");
  }
  const project = internals.project;
  enforceMutationAssetLimit(project, "build");
  await withCanonicalMutationLock(project.root, "build", async () => {
    await verifyLoadedProjectSnapshot(project, "build");
    const initialTarget = await snapshotFlatDirectory(project.buildDirectory, context(), "BUILD_UNSAFE_CONTENT", "Build target changed to unsafe content.", 130);
    if (!sameFlatDirectorySnapshot(internals.targetSnapshot, initialTarget)) {
      fail(context(), "BUILD_TARGET_CHANGED_DURING_PLAN", "Build target changed after planning.", project.project.buildDirectory);
    }
    const parent = dirname(project.buildDirectory);
    await resolveConfinedPath(project.root, project.project.buildDirectory, "build");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await resolveConfinedPath(project.root, project.project.buildDirectory, "build");
    const token = randomUUID();
    const stage = join(parent, `.${basename(project.buildDirectory)}.tfsb-stage-${token}`);
    const backup = join(parent, `.${basename(project.buildDirectory)}.tfsb-backup-${token}`);
    let backupCreated = false;
    let promoted = false;
    try {
      await mkdir(stage, { mode: 0o700 });
      for (const [name, bytes] of [...internals.files].sort(([left], [right]) => compareUtf8(left, right))) {
        await durableWrite(join(stage, name), bytes);
      }
      await syncPath(stage);
      await hooks.afterStage?.();
      await verifyLoadedProjectSnapshot(project, "build");
      const beforeRename = await snapshotFlatDirectory(project.buildDirectory, context(), "BUILD_UNSAFE_CONTENT", "Build target changed to unsafe content.", 130);
      if (!sameFlatDirectorySnapshot(internals.targetSnapshot, beforeRename)) {
        fail(context(), "BUILD_TARGET_CHANGED_DURING_PLAN", "Build target changed after planning.", project.project.buildDirectory);
      }
      if (beforeRename.kind === "directory") {
        await rename(project.buildDirectory, backup);
        backupCreated = true;
        await hooks.afterBackup?.();
      }
      const reservation = await snapshotFlatDirectory(project.buildDirectory, context(), "BUILD_UNSAFE_CONTENT", "Build target changed to unsafe content.", 130);
      if (reservation.kind !== "absent") {
        fail(context(), "BUILD_TARGET_CHANGED_DURING_PLAN", "Build target appeared during promotion.", project.project.buildDirectory);
      }
      await rename(stage, project.buildDirectory);
      promoted = true;
      await hooks.afterPromote?.();
      await syncPath(parent);
      if (backupCreated) {
        await rm(backup, { recursive: true });
        backupCreated = false;
        await syncPath(parent);
      }
    } catch (error) {
      let rollbackFailed = false;
      if (promoted) await rm(project.buildDirectory, { recursive: true, force: true }).catch(() => { rollbackFailed = true; });
      if (backupCreated) await rename(backup, project.buildDirectory).catch(() => { rollbackFailed = true; });
      await rm(stage, { recursive: true, force: true }).catch(() => { rollbackFailed = true; });
      if (rollbackFailed) {
        throw new DiagnosticError({ code: "ROLLBACK_BUILD_FAILED", operation: "build", domain: "filesystem", message: "Build replacement failed and the prior build could not be restored." });
      }
      throw error;
    }
  });
}

export async function buildProject(root: string, dryRun = false, hooks: BuildTestHooks = {}): Promise<BuildPlan> {
  const plan = await planBuild(root);
  if (!dryRun) await executeBuild(plan, hooks);
  return plan;
}
