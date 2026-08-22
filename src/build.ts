import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { loadCanonicalProject, type LoadedProject } from "./project.js";
import {
  BUILD_RECEIPT_FILENAME,
  createBuildReceipt,
  readBuildReceipt,
  receiptOwnsProject,
  serializeBuildReceipt,
  type BuildReceipt,
} from "./receipt.js";
import { resolveConfinedPath } from "./root.js";

export interface BuildPlan {
  readonly project: LoadedProject;
  readonly receipt: BuildReceipt;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly replacingExisting: boolean;
}

export interface BuildTestHooks {
  readonly afterBackup?: () => void | Promise<void>;
  readonly afterPromote?: () => void | Promise<void>;
}

export interface BuildInspection {
  readonly receipt?: BuildReceipt;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly different: readonly string[];
}

function context(): DiagnosticContext {
  return { operation: "build", domain: "filesystem" };
}

async function pathStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function inspectBuild(project: LoadedProject): Promise<BuildInspection> {
  const ctx = context();
  const existing = await pathStat(project.buildDirectory);
  if (existing === undefined) {
    return { missing: [...project.outputs.keys()], extra: [], different: [] };
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    fail(ctx, "BUILD_UNOWNED_DIRECTORY", "Build target is not a TFSB-owned directory.");
  }
  const receipt = await readBuildReceipt(project.buildDirectory);
  if (receipt === undefined || !receiptOwnsProject(receipt, project.project.buildDirectory)) {
    fail(ctx, "BUILD_UNOWNED_DIRECTORY", "Existing build directory is not proven to be TFSB-owned.");
  }
  const entries = await readdir(project.buildDirectory, { withFileTypes: true });
  const actual = entries
    .filter((entry) => entry.name !== BUILD_RECEIPT_FILENAME)
    .map((entry) => entry.name);
  if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) {
    fail(ctx, "BUILD_UNSAFE_CONTENT", "Owned build directory contains non-regular content.");
  }
  const expected = new Set(project.outputs.keys());
  const missing = [...expected].filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.has(name));
  const different: string[] = [];
  for (const [name, bytes] of project.outputs) {
    if (missing.includes(name)) continue;
    const actualBytes = await readFile(join(project.buildDirectory, name));
    if (!Buffer.from(actualBytes).equals(Buffer.from(bytes))) different.push(name);
  }
  return { receipt, missing, extra, different };
}

export async function planBuild(root: string): Promise<BuildPlan> {
  const ctx = context();
  const project = await loadCanonicalProject(root, "build");
  const existing = await pathStat(project.buildDirectory);
  if (existing?.isSymbolicLink() || (existing !== undefined && !existing.isDirectory())) {
    fail(ctx, "BUILD_UNOWNED_DIRECTORY", "Build target is not a TFSB-owned directory.", project.project.buildDirectory);
  }
  if (existing !== undefined) {
    const receipt = await readBuildReceipt(project.buildDirectory);
    if (receipt === undefined || !receiptOwnsProject(receipt, project.project.buildDirectory)) {
      fail(
        ctx,
        "BUILD_UNOWNED_DIRECTORY",
        "Existing build directory is not proven to be TFSB-owned for this project.",
        project.project.buildDirectory,
      );
    }
  }
  const receipt = createBuildReceipt(project);
  const files = new Map(project.outputs);
  files.set(BUILD_RECEIPT_FILENAME, serializeBuildReceipt(receipt));
  return { project, receipt, files, replacingExisting: existing !== undefined };
}

export async function executeBuild(plan: BuildPlan, hooks: BuildTestHooks = {}): Promise<void> {
  const ctx = context();
  const buildDirectory = plan.project.buildDirectory;
  const parent = dirname(buildDirectory);
  await resolveConfinedPath(plan.project.root, plan.project.project.buildDirectory, "build");
  await mkdir(parent, { recursive: true });
  await resolveConfinedPath(plan.project.root, plan.project.project.buildDirectory, "build");
  const stage = join(parent, `.${basename(buildDirectory)}.tfsb-stage-${randomUUID()}`);
  const backup = join(parent, `.${basename(buildDirectory)}.tfsb-backup-${randomUUID()}`);
  let backedUp = false;
  let promoted = false;
  try {
    await mkdir(stage, { mode: 0o700 });
    for (const [name, bytes] of plan.files) await writeFile(join(stage, name), bytes, { flag: "wx" });
    await resolveConfinedPath(plan.project.root, plan.project.project.buildDirectory, "build");
    if (plan.replacingExisting) {
      await rename(buildDirectory, backup);
      backedUp = true;
      await hooks.afterBackup?.();
    }
    await rename(stage, buildDirectory);
    promoted = true;
    await hooks.afterPromote?.();
    if (backedUp) await rm(backup, { recursive: true });
  } catch (error) {
    let rollbackError: unknown;
    try {
      if (promoted) await rm(buildDirectory, { recursive: true, force: true });
      if (backedUp) await rename(backup, buildDirectory);
    } catch (caught) {
      rollbackError = caught;
    }
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (rollbackError !== undefined) {
      throw new DiagnosticError({
        code: "ROLLBACK_BUILD_FAILED",
        operation: "build",
        domain: "filesystem",
        message: "Build replacement failed and the prior build could not be restored.",
      });
    }
    throw error;
  }
}

export async function buildProject(
  root: string,
  dryRun = false,
  hooks: BuildTestHooks = {},
): Promise<BuildPlan> {
  const plan = await planBuild(root);
  if (!dryRun) await executeBuild(plan, hooks);
  return plan;
}
