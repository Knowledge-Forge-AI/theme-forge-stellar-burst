import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { inspectBuild } from "./build.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { loadCanonicalProject, type LoadedProject } from "./project.js";
import { resolveConfinedPath } from "./root.js";

export interface InstallPlanItem {
  readonly assetId: string;
  readonly source: string;
  readonly configuredDestination: string;
  readonly destination: string;
  readonly bytes: Uint8Array;
}

export interface InstallPlan {
  readonly project: LoadedProject;
  readonly items: readonly InstallPlanItem[];
}

export interface InstallTestHooks {
  readonly beforeReplace?: (index: number) => void | Promise<void>;
  readonly beforeRollback?: (index: number) => void | Promise<void>;
  readonly beforeCleanup?: (index: number) => void | Promise<void>;
}

interface StagedInstall extends InstallPlanItem {
  readonly stage: string;
  readonly backup: string;
  originalExisted: boolean;
  installed: boolean;
  backupCreated: boolean;
}

function context(): DiagnosticContext {
  return { operation: "install", domain: "filesystem" };
}

async function pathStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function planInstall(root: string): Promise<InstallPlan> {
  const ctx = context();
  const project = await loadCanonicalProject(root, "install");
  const inspection = await inspectBuild(project);
  if (inspection.missing.length > 0 || inspection.extra.length > 0 || inspection.different.length > 0) {
    fail(ctx, "INSTALL_STALE_BUILD", "Install requires exact current canonical build outputs.");
  }
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const items: InstallPlanItem[] = [];
  const destinations = new Set<string>();
  for (const install of project.project.installs) {
    const asset = assets.get(install.asset);
    if (asset === undefined) throw new Error("Validated install asset unexpectedly disappeared.");
    const bytes = project.outputs.get(asset.filename);
    if (bytes === undefined) throw new Error("Validated build output unexpectedly disappeared.");
    const resolved = project.installDestinations.get(install.asset) ?? [];
    for (const [destinationIndex, destination] of resolved.entries()) {
      if (destinations.has(destination)) {
        fail(ctx, "INSTALL_DESTINATION_COLLISION", `Install destination '${destination}' is duplicated.`);
      }
      destinations.add(destination);
      const existing = await pathStat(destination);
      if (existing?.isSymbolicLink() || (existing !== undefined && !existing.isFile())) {
        fail(ctx, "INSTALL_UNSAFE_DESTINATION", `Install destination '${destination}' is not a regular file.`);
      }
      items.push({
        assetId: asset.id,
        source: join(project.buildDirectory, asset.filename),
        configuredDestination: install.destinations[destinationIndex] ?? "",
        destination,
        bytes,
      });
    }
  }
  for (const companion of project.project.companions ?? []) {
    const bytes = project.companions.get(companion.file);
    if (bytes === undefined) throw new Error("Validated companion unexpectedly disappeared.");
    const resolved = project.companionDestinations.get(companion.file) ?? [];
    for (const [destinationIndex, destination] of resolved.entries()) {
      if (destinations.has(destination)) {
        fail(ctx, "INSTALL_DESTINATION_COLLISION", `Install destination '${destination}' is duplicated.`);
      }
      destinations.add(destination);
      const existing = await pathStat(destination);
      if (existing?.isSymbolicLink() || (existing !== undefined && !existing.isFile())) {
        fail(ctx, "INSTALL_UNSAFE_DESTINATION", `Install destination '${destination}' is not a regular file.`);
      }
      items.push({
        assetId: `companion:${companion.file}`,
        source: join(project.root, ".tfsb", "companions", companion.file),
        configuredDestination: companion.destinations[destinationIndex] ?? "",
        destination,
        bytes,
      });
    }
  }
  return { project, items };
}

export async function executeInstall(
  plan: InstallPlan,
  hooks: InstallTestHooks = {},
): Promise<void> {
  const currentBuild = await inspectBuild(plan.project);
  if (
    currentBuild.missing.length > 0 ||
    currentBuild.extra.length > 0 ||
    currentBuild.different.length > 0
  ) {
    fail(context(), "INSTALL_STALE_BUILD", "Install requires exact current canonical build outputs.");
  }
  const staged: StagedInstall[] = [];
  try {
    for (const item of plan.items) {
      const parent = dirname(item.destination);
      await resolveConfinedPath(plan.project.root, item.configuredDestination, "install");
      await mkdir(parent, { recursive: true });
      await resolveConfinedPath(plan.project.root, item.configuredDestination, "install");
      const token = randomUUID();
      const stage = join(parent, `.${basename(item.destination)}.tfsb-stage-${token}`);
      const backup = join(parent, `.${basename(item.destination)}.tfsb-backup-${token}`);
      await writeFile(stage, item.bytes, { flag: "wx" });
      staged.push({
        ...item,
        stage,
        backup,
        originalExisted: false,
        installed: false,
        backupCreated: false,
      });
    }
    for (const [index, item] of staged.entries()) {
      await resolveConfinedPath(
        plan.project.root,
        item.configuredDestination,
        "install",
      );
      await hooks.beforeReplace?.(index);
      const existing = await pathStat(item.destination);
      if (existing?.isSymbolicLink() || (existing !== undefined && !existing.isFile())) {
        fail(context(), "INSTALL_UNSAFE_DESTINATION", `Install destination '${item.destination}' changed before replacement.`);
      }
      item.originalExisted = existing !== undefined;
      if (item.originalExisted) {
        await rename(item.destination, item.backup);
        item.backupCreated = true;
      }
      await rename(item.stage, item.destination);
      item.installed = true;
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
      } catch {
        partial = true;
      }
    }
    throw new DiagnosticError({
      code: partial ? "INSTALL_FAILED_PARTIAL" : "INSTALL_FAILED_ROLLED_BACK",
      operation: "install",
      domain: "filesystem",
      message: partial
        ? "Install failed and at least one prior destination could not be restored."
        : "Install failed; every begun replacement was rolled back.",
      ...(error instanceof DiagnosticError && error.diagnostic.location !== undefined
        ? { location: error.diagnostic.location }
        : {}),
    });
  }
  let cleanupFailed = false;
  for (const [index, item] of staged.entries()) {
    if (!item.backupCreated) continue;
    try {
      await hooks.beforeCleanup?.(index);
      await rm(item.backup, { force: true });
      item.backupCreated = false;
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    throw new DiagnosticError({
      code: "INSTALL_BACKUP_CLEANUP_FAILED",
      operation: "install",
      domain: "filesystem",
      message: "Install succeeded, but at least one prior-file backup could not be removed.",
    });
  }
}

export async function installProject(
  root: string,
  dryRun = false,
  hooks: InstallTestHooks = {},
): Promise<InstallPlan> {
  const plan = await planInstall(root);
  if (!dryRun) await executeInstall(plan, hooks);
  return plan;
}
