import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { inspectBuildSnapshot } from "./build.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import {
  durableWrite,
  sameFileSnapshot,
  sameFlatDirectorySnapshot,
  snapshotRegularFile,
  snapshotFlatDirectory,
  syncPath,
  type FileSnapshot,
  type FlatDirectorySnapshot,
} from "./filesystem.js";
import {
  enforceMutationAssetLimit,
  loadCanonicalProject,
  verifyLoadedProjectSnapshot,
  type LoadedProject,
} from "./project.js";
import { compareUtf8 } from "./provenance.js";
import { resolveConfinedPath } from "./root.js";
import { withCanonicalMutationLock } from "./transaction.js";

const installPlanBrand: unique symbol = Symbol("tfsb-install-plan");

export interface InstallPlanItem {
  readonly assetId: string;
  readonly source: string;
  readonly configuredDestination: string;
}

interface InstallExecutionItem extends InstallPlanItem {
  readonly destination: string;
  readonly bytes: Uint8Array;
}

export interface InstallPlan {
  readonly items: readonly InstallPlanItem[];
  readonly [installPlanBrand]: true;
}

interface InstallPlanInternals {
  readonly project: LoadedProject;
  readonly items: readonly InstallExecutionItem[];
  readonly buildSnapshot: FlatDirectorySnapshot;
  readonly destinationSnapshots: ReadonlyMap<string, FileSnapshot>;
}

const installPlanInternals = new WeakMap<InstallPlan, InstallPlanInternals>();

export interface InstallTestHooks {
  readonly afterStage?: () => void | Promise<void>;
  readonly beforeReplace?: (index: number) => void | Promise<void>;
  readonly beforeRollback?: (index: number) => void | Promise<void>;
  readonly beforeCleanup?: (index: number) => void | Promise<void>;
}

interface StagedInstall extends InstallExecutionItem {
  readonly stage: string;
  readonly backup: string;
  installed: boolean;
  backupCreated: boolean;
}

function context(): DiagnosticContext {
  return { operation: "install", domain: "filesystem" };
}

async function destinationSnapshot(path: string): Promise<FileSnapshot> {
  return snapshotRegularFile(
    path,
    context(),
    "INSTALL_UNSAFE_DESTINATION",
    "Install destination must be absent or one non-symlink regular file.",
  );
}

function publicItems(items: readonly InstallExecutionItem[]): readonly InstallPlanItem[] {
  return Object.freeze(items.map((item) => Object.freeze({ assetId: item.assetId, source: item.source, configuredDestination: item.configuredDestination })));
}

function privateItems(items: readonly InstallExecutionItem[]): readonly InstallExecutionItem[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item, bytes: Buffer.from(item.bytes) })));
}

export async function planInstall(root: string): Promise<InstallPlan> {
  const ctx = context();
  const project = await loadCanonicalProject(root, "install");
  enforceMutationAssetLimit(project, "install");
  const build = await inspectBuildSnapshot(project, "install");
  if (build.inspection.missing.length > 0 || build.inspection.extra.length > 0 || build.inspection.different.length > 0) {
    fail(ctx, "INSTALL_STALE_BUILD", "Install requires exact current canonical build outputs.");
  }
  if (build.snapshot.kind !== "directory") fail(ctx, "INSTALL_STALE_BUILD", "Install requires an existing current build.");
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const items: InstallExecutionItem[] = [];
  const destinations = new Set<string>();
  const destinationSnapshots = new Map<string, FileSnapshot>();
  for (const install of project.project.installs) {
    const asset = assets.get(install.asset);
    if (asset === undefined) throw new Error("Validated install asset unexpectedly disappeared.");
    const built = build.snapshot.files.get(asset.filename);
    if (built === undefined || built.kind !== "file") throw new Error("Validated build output unexpectedly disappeared.");
    const resolved = project.installDestinations.get(install.asset) ?? [];
    for (const [destinationIndex, destination] of resolved.entries()) {
      if (destinations.has(destination)) fail(ctx, "INSTALL_DESTINATION_COLLISION", "Install destination is duplicated.");
      destinations.add(destination);
      destinationSnapshots.set(destination, await destinationSnapshot(destination));
      items.push({
        assetId: asset.id,
        source: `${project.project.buildDirectory}/${asset.filename}`,
        configuredDestination: install.destinations[destinationIndex] ?? "",
        destination,
        bytes: Buffer.from(built.bytes),
      });
    }
  }
  for (const companion of project.project.companions) {
    const bytes = project.companions.get(companion.file);
    if (bytes === undefined) throw new Error("Validated companion unexpectedly disappeared.");
    const resolved = project.companionDestinations.get(companion.file) ?? [];
    for (const [destinationIndex, destination] of resolved.entries()) {
      if (destinations.has(destination)) fail(ctx, "INSTALL_DESTINATION_COLLISION", "Install destination is duplicated.");
      destinations.add(destination);
      destinationSnapshots.set(destination, await destinationSnapshot(destination));
      items.push({
        assetId: `companion:${companion.file}`,
        source: `.tfsb/companions/${companion.file}`,
        configuredDestination: companion.destinations[destinationIndex] ?? "",
        destination,
        bytes: Buffer.from(bytes),
      });
    }
  }
  items.sort((left, right) => compareUtf8(left.configuredDestination, right.configuredDestination));
  await verifyLoadedProjectSnapshot(project, "install");
  const exposedItems = publicItems(items);
  const plan = Object.freeze({ items: exposedItems, [installPlanBrand]: true as const });
  installPlanInternals.set(plan, {
    project,
    items: privateItems(items),
    buildSnapshot: build.snapshot,
    destinationSnapshots,
  });
  return plan;
}

async function verifyDestinationSnapshots(internals: InstallPlanInternals): Promise<void> {
  for (const item of internals.items) {
    const expected = internals.destinationSnapshots.get(item.destination);
    if (expected === undefined || !sameFileSnapshot(expected, await destinationSnapshot(item.destination))) {
      fail(context(), "INSTALL_DESTINATION_CHANGED_DURING_PLAN", "An install destination changed after planning.", item.configuredDestination);
    }
  }
}

export async function executeInstall(plan: InstallPlan, hooks: InstallTestHooks = {}): Promise<void> {
  const internals = installPlanInternals.get(plan);
  if (internals === undefined || !Object.isFrozen(plan) || !Object.isFrozen(plan.items)) {
    fail(context(), "INSTALL_INVALID_PLAN", "Install plan is not authentic.");
  }
  enforceMutationAssetLimit(internals.project, "install");
  await withCanonicalMutationLock(internals.project.root, "install", async () => {
    await verifyLoadedProjectSnapshot(internals.project, "install");
    const currentBuild = await snapshotFlatDirectory(internals.project.buildDirectory, context(), "BUILD_UNSAFE_CONTENT", "Build target changed to unsafe content.", 130);
    if (!sameFlatDirectorySnapshot(internals.buildSnapshot, currentBuild)) {
      fail(context(), "INSTALL_STALE_BUILD", "Build state changed after install planning.");
    }
    await verifyDestinationSnapshots(internals);
    const staged: StagedInstall[] = [];
    try {
      for (const item of internals.items) {
        const parent = dirname(item.destination);
        await resolveConfinedPath(internals.project.root, item.configuredDestination, "install");
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await resolveConfinedPath(internals.project.root, item.configuredDestination, "install");
        const token = randomUUID();
        const stage = join(parent, `.${basename(item.destination)}.tfsb-stage-${token}`);
        const backup = join(parent, `.${basename(item.destination)}.tfsb-backup-${token}`);
        await durableWrite(stage, item.bytes);
        staged.push({ ...item, stage, backup, installed: false, backupCreated: false });
      }
      for (const parent of new Set(staged.map((item) => dirname(item.stage)))) await syncPath(parent);
      await hooks.afterStage?.();
      await verifyLoadedProjectSnapshot(internals.project, "install");
      const buildBeforeReplace = await snapshotFlatDirectory(internals.project.buildDirectory, context(), "BUILD_UNSAFE_CONTENT", "Build target changed to unsafe content.", 130);
      if (!sameFlatDirectorySnapshot(internals.buildSnapshot, buildBeforeReplace)) fail(context(), "INSTALL_STALE_BUILD", "Build state changed after install planning.");
      await verifyDestinationSnapshots(internals);
      for (const [index, item] of staged.entries()) {
        await hooks.beforeReplace?.(index);
        const expected = internals.destinationSnapshots.get(item.destination);
        if (expected === undefined || !sameFileSnapshot(expected, await destinationSnapshot(item.destination))) {
          fail(context(), "INSTALL_DESTINATION_CHANGED_DURING_PLAN", "An install destination changed after planning.", item.configuredDestination);
        }
        if (expected.kind === "file") {
          await rename(item.destination, item.backup);
          item.backupCreated = true;
        }
        await rename(item.stage, item.destination);
        item.installed = true;
        await syncPath(dirname(item.destination));
      }
    } catch (error) {
      let partial = false;
      for (let index = staged.length - 1; index >= 0; index -= 1) {
        const item = staged[index];
        if (item === undefined) continue;
        try {
          await hooks.beforeRollback?.(index);
          if (item.installed) await rm(item.destination, { force: true });
          if (item.backupCreated) await rename(item.backup, item.destination);
          await rm(item.stage, { force: true });
          await syncPath(dirname(item.destination));
        } catch {
          partial = true;
        }
      }
      throw new DiagnosticError({
        code: partial ? "INSTALL_FAILED_PARTIAL" : "INSTALL_FAILED_ROLLED_BACK",
        operation: "install",
        domain: "filesystem",
        message: partial ? "Install failed and at least one prior destination could not be restored." : "Install failed; every begun replacement was rolled back.",
        ...(error instanceof DiagnosticError && error.diagnostic.location !== undefined ? { location: error.diagnostic.location } : {}),
      });
    }
    let cleanupFailed = false;
    for (const [index, item] of staged.entries()) {
      if (!item.backupCreated) continue;
      try {
        await hooks.beforeCleanup?.(index);
        await rm(item.backup, { force: true });
        item.backupCreated = false;
        await syncPath(dirname(item.destination));
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      throw new DiagnosticError({ code: "INSTALL_BACKUP_CLEANUP_FAILED", operation: "install", domain: "filesystem", message: "Install succeeded, but at least one prior-file backup could not be removed." });
    }
  });
}

export async function installProject(root: string, dryRun = false, hooks: InstallTestHooks = {}): Promise<InstallPlan> {
  const plan = await planInstall(root);
  if (!dryRun) await executeInstall(plan, hooks);
  return plan;
}
