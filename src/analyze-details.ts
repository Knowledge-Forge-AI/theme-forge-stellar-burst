import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ANALYZE_COMMON_V03_PROFILE,
  ANALYZE_SCHEMA1_PROFILE,
  type AnalyzeDetailsFooter,
  type AnalyzeDetailsHeader,
  type AnalyzeResult,
} from "./analyze-contract.js";
import { containsAnalyzeInput, verifyAnalyzeInputPlan, type AnalyzeInputPlan } from "./analyze-source.js";
import { DiagnosticError, diagnostic } from "./diagnostics.js";
import { readRegularFileSnapshot } from "./filesystem.js";
import { parseProjectToml } from "./toml.js";

interface DirectoryIdentity { readonly dev: number; readonly ino: number; readonly mode: number; }
export interface AnalyzeDetailsPlan { readonly targetPath: string; readonly parentPath: string; readonly parentIdentity: DirectoryIdentity; readonly input: AnalyzeInputPlan; }
export interface AnalyzeDetailsPublicationResult { readonly published: true; readonly targetPath: string; readonly cleanupResidue: string | null; }
export interface AnalyzeDetailsHooks {
  readonly beforeCreate?: () => void | Promise<void>; readonly afterCreate?: () => void | Promise<void>;
  readonly beforeWrite?: () => void | Promise<void>; readonly afterWrite?: () => void | Promise<void>;
  readonly beforeTempSync?: () => void | Promise<void>; readonly beforeTempClose?: () => void | Promise<void>;
  readonly beforeInputRevalidation?: () => void | Promise<void>; readonly beforeParentRevalidation?: () => void | Promise<void>; readonly beforeTargetRevalidation?: () => void | Promise<void>; readonly beforeLink?: () => void | Promise<void>;
  readonly afterLink?: () => void | Promise<void>; readonly beforeParentSync?: () => void | Promise<void>;
  readonly beforeTempRemoval?: () => void | Promise<void>; readonly afterTempRemoval?: () => void | Promise<void>; readonly beforeFinalParentSync?: () => void | Promise<void>;
}

function detailsError(code: "ANALYZE_DETAILS_TARGET_INVALID" | "ANALYZE_DETAILS_WRITE_FAILED", message: string): DiagnosticError { return new DiagnosticError(diagnostic({ operation: "analyze", domain: "filesystem" }, code, message)); }
function directoryIdentity(stat: Stats): DirectoryIdentity { return { dev: stat.dev, ino: stat.ino, mode: stat.mode }; }
function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode; }
function within(parent: string, child: string): boolean { const value = relative(parent, child); return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value)); }
function overlaps(first: string, second: string): boolean { return within(first, second) || within(second, first); }

async function validateParent(path: string): Promise<DirectoryIdentity> {
  const absolute = resolve(path); const root = absolute.startsWith(sep) ? sep : absolute.slice(0, 3); let cursor = root;
  const pieces = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const piece of pieces) {
    cursor = join(cursor, piece); const stat = await lstat(cursor).catch(() => undefined);
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) throw detailsError("ANALYZE_DETAILS_TARGET_INVALID", "Every existing details parent component must be a real non-symlink directory.");
  }
  const stat = await lstat(absolute);
  return directoryIdentity(stat);
}

async function discoverProjectRoot(cwd: string): Promise<string | null> {
  let cursor = resolve(cwd);
  while (true) {
    const marker = await lstat(join(cursor, ".tfsb", "project.toml")).catch(() => undefined);
    if (marker?.isFile() === true && !marker.isSymbolicLink()) return cursor;
    const parent = dirname(cursor); if (parent === cursor) return null; cursor = parent;
  }
}

export async function planAnalyzeDetails(input: AnalyzeInputPlan, target: string): Promise<AnalyzeDetailsPlan> {
  if (target === "" || target.includes("\0")) throw detailsError("ANALYZE_DETAILS_TARGET_INVALID", "A non-empty details target is required.");
  const targetPath = isAbsolute(target) ? resolve(target) : resolve(input.invocationCwd, target);
  if (!isAbsolute(target)) { const rel = relative(input.invocationCwd, targetPath); if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw detailsError("ANALYZE_DETAILS_TARGET_INVALID", "A relative details target cannot escape the invocation directory."); }
  if (containsAnalyzeInput(input, targetPath)) throw detailsError("ANALYZE_DETAILS_TARGET_INVALID", "The details target must be disjoint from the analyzed input.");
  if (await lstat(targetPath).catch(() => undefined) !== undefined) throw detailsError("ANALYZE_DETAILS_TARGET_INVALID", "The details target must be absent.");
  const projectRoot = await discoverProjectRoot(input.invocationCwd);
  if (projectRoot !== null) {
    const protectedPaths = [".git", ".tfsb", ".tfsb-preview", "src", "test", "docs", "dist"].map((tree) => join(projectRoot, tree));
    try {
      const projectFile = join(projectRoot, ".tfsb", "project.toml");
      const snapshot = await readRegularFileSnapshot(projectFile, { operation: "analyze", domain: "project-toml" }, "ANALYZE_DETAILS_TARGET_INVALID", "The discovered project policy could not be read safely.", 1024 * 1024);
      const parsed = parseProjectToml(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes), projectFile);
      if (!parsed.ok) throw detailsError("ANALYZE_DETAILS_TARGET_INVALID", "The discovered project policy is invalid.");
      protectedPaths.push(join(projectRoot, parsed.value.buildDirectory));
      for (const install of parsed.value.installs) for (const destination of install.destinations) protectedPaths.push(join(projectRoot, destination));
      for (const companion of parsed.value.companions) for (const destination of companion.destinations) protectedPaths.push(join(projectRoot, destination));
    } catch (error) { if (error instanceof DiagnosticError && error.diagnostic.code === "ANALYZE_DETAILS_TARGET_INVALID") throw error; throw detailsError("ANALYZE_DETAILS_TARGET_INVALID", "The discovered project policy could not be applied safely."); }
    if (protectedPaths.some((path) => overlaps(path, targetPath))) throw detailsError("ANALYZE_DETAILS_TARGET_INVALID", "The details target overlaps a protected project tree or configured destination.");
  }
  const parentPath = dirname(targetPath); const parentIdentity = await validateParent(parentPath);
  return { targetPath, parentPath, parentIdentity, input };
}

export function serializeAnalyzeDetailsLines(result: AnalyzeResult): readonly string[] {
  const header: AnalyzeDetailsHeader = { recordType: "header", schema: "tfsb-analyze-details", schemaVersion: 1, inputKind: result.data.input.kind, profiles: { schema1: ANALYZE_SCHEMA1_PROFILE, commonV03: ANALYZE_COMMON_V03_PROFILE } };
  const recordLines = [`${JSON.stringify(header)}\n`, ...result.files.map((file) => `${JSON.stringify(file)}\n`)];
  const recordsSha256 = `sha256:${createHash("sha256").update(recordLines.join(""), "utf8").digest("hex")}` as const;
  const footer: AnalyzeDetailsFooter = { recordType: "footer", records: result.files.length, profiles: { schema1: result.data.profiles.schema1.counts, commonV03: result.data.profiles.commonV03.counts }, recordsSha256 };
  return [...recordLines, `${JSON.stringify(footer)}\n`];
}

export async function* serializeAnalyzeDetails(result: AnalyzeResult): AsyncIterable<string> { for (const line of serializeAnalyzeDetailsLines(result)) yield line; }

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> { let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset, null); if (result.bytesWritten <= 0) throw new Error("short write"); offset += result.bytesWritten; } }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }

export async function publishAnalyzeDetails(plan: AnalyzeDetailsPlan, result: AnalyzeResult, hooks: AnalyzeDetailsHooks = {}): Promise<AnalyzeDetailsPublicationResult> {
  const tempPath = join(plan.parentPath, `.${randomBytes(18).toString("hex")}.tfsb-analyze.tmp`);
  let handle: FileHandle | undefined; let tempOwned = false; let published = false;
  try {
    await hooks.beforeCreate?.();
    handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); tempOwned = true;
    await hooks.afterCreate?.(); await hooks.beforeWrite?.();
    for (const line of serializeAnalyzeDetailsLines(result)) await writeAll(handle, Buffer.from(line, "utf8"));
    await hooks.afterWrite?.(); await hooks.beforeTempSync?.(); await handle.sync(); await hooks.beforeTempClose?.(); await handle.close(); handle = undefined;
    await hooks.beforeInputRevalidation?.(); await verifyAnalyzeInputPlan(plan.input);
    await hooks.beforeParentRevalidation?.();
    const parent = await lstat(plan.parentPath).catch(() => undefined);
    if (parent === undefined || parent.isSymbolicLink() || !parent.isDirectory() || !sameDirectory(plan.parentIdentity, directoryIdentity(parent))) throw detailsError("ANALYZE_DETAILS_TARGET_INVALID", "The details target or parent changed before publication.");
    await hooks.beforeTargetRevalidation?.();
    if (await lstat(plan.targetPath).catch(() => undefined) !== undefined) throw detailsError("ANALYZE_DETAILS_TARGET_INVALID", "The details target or parent changed before publication.");
    await hooks.beforeLink?.(); await link(tempPath, plan.targetPath); published = true; await hooks.afterLink?.();
    await hooks.beforeParentSync?.(); await syncDirectory(plan.parentPath);
    await hooks.beforeTempRemoval?.(); await unlink(tempPath); tempOwned = false; await hooks.afterTempRemoval?.(); await hooks.beforeFinalParentSync?.(); await syncDirectory(plan.parentPath);
    return { published: true, targetPath: plan.targetPath, cleanupResidue: null };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (tempOwned && !published) await unlink(tempPath).catch(() => undefined);
    if (error instanceof DiagnosticError) throw error;
    throw detailsError("ANALYZE_DETAILS_WRITE_FAILED", published ? `The complete details target was published, but transaction cleanup did not finish (residue: ${tempPath}).` : "The details report could not be published without overwrite risk.");
  }
}
