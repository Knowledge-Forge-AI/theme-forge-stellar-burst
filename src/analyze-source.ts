import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { readArchive } from "./archive.js";
import { ANALYZE_LIMITS, type AnalyzeDetailsFile, type AnalyzeInputKind } from "./analyze-contract.js";
import { scanAnalyzeSvg } from "./analyze-scanner.js";
import { DiagnosticError, diagnostic, fail } from "./diagnostics.js";
import { compareUtf8 } from "./provenance.js";

interface Identity { readonly dev: number; readonly ino: number; readonly mode: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number; }
interface DirectoryEntrySnapshot { readonly path: string; readonly kind: "directory" | "file"; readonly identity: Identity; }
export interface AnalyzeInputPlan {
  readonly kind: AnalyzeInputKind;
  readonly inputPath: string;
  readonly invocationCwd: string;
  readonly directoryEntries?: readonly DirectoryEntrySnapshot[];
  readonly archiveIdentity?: Identity;
}
export interface AnalyzeSourceResult {
  readonly files: readonly AnalyzeDetailsFile[];
  readonly totalFiles: number;
  readonly sourceBytes: number;
  readonly maxFileBytes: number;
  readonly xmlElements: number;
}

function identity(stat: Stats): Identity { return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function sameIdentity(left: Identity, right: Identity): boolean { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function sourceFail(code: "ANALYZE_INPUT_INVALID" | "ANALYZE_SOURCE_CHANGED" | "ANALYZE_SNAPSHOT_FAILED" | "ANALYZE_CANDIDATE_LIMIT_EXCEEDED" | "ANALYZE_SVG_FILE_LIMIT_EXCEEDED" | "ANALYZE_AGGREGATE_BYTE_LIMIT_EXCEEDED" | "ANALYZE_ANALYSIS_ELEMENT_LIMIT_EXCEEDED" | "ANALYZE_ARCHIVE_BYTE_LIMIT_EXCEEDED", message: string): never { fail({ operation: "analyze", domain: "analyze" }, code, message); }
function relativePath(root: string, path: string): string { return relative(root, path).split(sep).join("/"); }
export function deriveAnalyzeAssetId(path: string): string | null { const stem = basename(path).slice(0, -extname(path).length).normalize("NFC"); const value = stem.toLowerCase().replace(/[ _]+/g, "-"); return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? value : null; }

async function validateInputComponents(path: string): Promise<void> {
  const absolute = resolve(path); const root = absolute.startsWith(sep) ? sep : absolute.slice(0, 3); let cursor = root;
  for (const piece of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, piece); const stat = await lstat(cursor).catch(() => undefined);
    if (stat === undefined) sourceFail("ANALYZE_INPUT_INVALID", "Analyze input does not exist or cannot be inspected.");
    if (stat.isSymbolicLink()) sourceFail("ANALYZE_INPUT_INVALID", "Analyze input cannot cross a symbolic-link boundary.");
  }
}

async function directorySnapshot(root: string): Promise<readonly DirectoryEntrySnapshot[]> {
  const snapshots: DirectoryEntrySnapshot[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { sourceFail("ANALYZE_SNAPSHOT_FAILED", "The directory inventory could not be read safely."); }
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      if (snapshots.length >= ANALYZE_LIMITS.candidateEntries) sourceFail("ANALYZE_CANDIDATE_LIMIT_EXCEEDED", "The input exceeds the fixed candidate limit.");
      const absolute = join(directory, entry.name);
      let stat;
      try { stat = await lstat(absolute); } catch { sourceFail("ANALYZE_SOURCE_CHANGED", "The input changed while its directory inventory was read."); }
      if (stat.isSymbolicLink()) sourceFail("ANALYZE_SNAPSHOT_FAILED", "The directory inventory contains a symbolic-link boundary.");
      if (!stat.isDirectory() && !stat.isFile()) sourceFail("ANALYZE_SNAPSHOT_FAILED", "The directory inventory contains a non-regular candidate.");
      snapshots.push({ path: relativePath(root, absolute), kind: stat.isDirectory() ? "directory" : "file", identity: identity(stat) });
      if (stat.isDirectory()) await walk(absolute);
    }
  };
  await walk(root);
  return snapshots;
}

async function hasZipSignature(path: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const buffer = Buffer.alloc(4); const { bytesRead } = await handle.read(buffer, 0, 4, 0); return bytesRead === 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && ((buffer[2] === 0x03 && buffer[3] === 0x04) || (buffer[2] === 0x05 && buffer[3] === 0x06) || (buffer[2] === 0x07 && buffer[3] === 0x08)); }
  catch { return false; } finally { await handle?.close(); }
  return false;
}

export async function inspectAnalyzeInput(input: string, invocationCwd = process.cwd()): Promise<AnalyzeInputPlan> {
  const inputPath = resolve(invocationCwd, input);
  await validateInputComponents(inputPath);
  let stat;
  try { stat = await lstat(inputPath); } catch { sourceFail("ANALYZE_INPUT_INVALID", "Analyze input does not exist or cannot be inspected."); }
  if (stat.isSymbolicLink()) sourceFail("ANALYZE_INPUT_INVALID", "Analyze input cannot be a symbolic link.");
  if (stat.isDirectory()) return { kind: "directory", inputPath, invocationCwd: resolve(invocationCwd), directoryEntries: await directorySnapshot(inputPath) };
  if (!stat.isFile() || !(await hasZipSignature(inputPath))) sourceFail("ANALYZE_INPUT_INVALID", "Analyze input must be a directory or a regular ZIP file identified by signature.");
  if (stat.size > ANALYZE_LIMITS.archiveBytes) sourceFail("ANALYZE_ARCHIVE_BYTE_LIMIT_EXCEEDED", "Analyze ZIP exceeds the fixed raw archive limit.");
  return { kind: "archive", inputPath, invocationCwd: resolve(invocationCwd), archiveIdentity: identity(stat) };
}

export async function verifyAnalyzeInputPlan(plan: AnalyzeInputPlan): Promise<void> {
  if (plan.kind === "directory") {
    const current = await directorySnapshot(plan.inputPath).catch(() => undefined);
    const before = plan.directoryEntries;
    if (current === undefined || before === undefined || current.length !== before.length || current.some((item, index) => { const expected = before[index]; return expected === undefined || item.path !== expected.path || item.kind !== expected.kind || !sameIdentity(item.identity, expected.identity); })) sourceFail("ANALYZE_SOURCE_CHANGED", "The directory input changed during analysis.");
    return;
  }
  const stat = await lstat(plan.inputPath).catch(() => undefined);
  if (stat === undefined || stat.isSymbolicLink() || !stat.isFile() || plan.archiveIdentity === undefined || !sameIdentity(plan.archiveIdentity, identity(stat))) sourceFail("ANALYZE_SOURCE_CHANGED", "The archive input changed during analysis.");
}

async function readPlannedFile(plan: AnalyzeInputPlan, item: DirectoryEntrySnapshot): Promise<Uint8Array> {
  const absolute = join(plan.inputPath, ...item.path.split("/"));
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(item.identity, identity(opened))) sourceFail("ANALYZE_SOURCE_CHANGED", "An SVG changed before it was read.");
    if (opened.size > ANALYZE_LIMITS.aggregateSvgBytes) sourceFail("ANALYZE_AGGREGATE_BYTE_LIMIT_EXCEEDED", "The input exceeds the fixed aggregate SVG byte limit.");
    const bytes = Buffer.allocUnsafe(opened.size);
    let position = 0;
    while (position < bytes.length) { const read = await handle.read(bytes, position, Math.min(64 * 1024, bytes.length - position), position); if (read.bytesRead === 0) sourceFail("ANALYZE_SOURCE_CHANGED", "An SVG became truncated while it was read."); position += read.bytesRead; }
    const final = await handle.stat(); const pathStat = await lstat(absolute);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !sameIdentity(item.identity, identity(final)) || !sameIdentity(item.identity, identity(pathStat))) sourceFail("ANALYZE_SOURCE_CHANGED", "An SVG changed while it was read.");
    return bytes;
  } catch (error) { if (error instanceof DiagnosticError) throw error; throw new DiagnosticError(diagnostic({ operation: "analyze", domain: "analyze" }, "ANALYZE_SNAPSHOT_FAILED", "An SVG could not be opened as a regular no-follow file.")); }
  finally { await handle?.close(); }
}

export async function executeAnalyzeSource(plan: AnalyzeInputPlan): Promise<AnalyzeSourceResult> {
  await verifyAnalyzeInputPlan(plan);
  const results: AnalyzeDetailsFile[] = [];
  let totalFiles = 0; let sourceBytes = 0; let maxFileBytes = 0; let xmlElements = 0;
  const consume = (path: string, bytes: Uint8Array): void => {
    sourceBytes += bytes.byteLength; maxFileBytes = Math.max(maxFileBytes, bytes.byteLength);
    if (sourceBytes > ANALYZE_LIMITS.aggregateSvgBytes) sourceFail("ANALYZE_AGGREGATE_BYTE_LIMIT_EXCEEDED", "The input exceeds the fixed aggregate SVG byte limit.");
    const scanned = scanAnalyzeSvg(bytes, path, deriveAnalyzeAssetId(path)); xmlElements += scanned.xmlElements;
    if (xmlElements > ANALYZE_LIMITS.analysisXmlElements) sourceFail("ANALYZE_ANALYSIS_ELEMENT_LIMIT_EXCEEDED", "The input exceeds the fixed analysis element limit.");
    results.push(scanned.file);
  };
  if (plan.kind === "directory") {
    const entries = plan.directoryEntries ?? [];
    const files = entries.filter((item) => item.kind === "file"); totalFiles = files.length;
    const svgs = files.filter((item) => extname(item.path).toLowerCase() === ".svg");
    if (svgs.length > ANALYZE_LIMITS.svgFiles) sourceFail("ANALYZE_SVG_FILE_LIMIT_EXCEEDED", "The input exceeds the fixed SVG-file limit.");
    const declared = svgs.reduce((total, item) => total + item.identity.size, 0);
    if (declared > ANALYZE_LIMITS.aggregateSvgBytes) sourceFail("ANALYZE_AGGREGATE_BYTE_LIMIT_EXCEEDED", "The input exceeds the fixed aggregate SVG byte limit.");
    for (const item of svgs) consume(item.path, await readPlannedFile(plan, item));
  } else {
    try {
      const archive = await readArchive(plan.inputPath, [], [], {
        operation: "analyze", selectAllSvgs: true, allowNoSvgs: true, retainSelectedSvgs: false,
        limits: { totalEntries: ANALYZE_LIMITS.candidateEntries, selectedSvgEntries: ANALYZE_LIMITS.svgFiles, selectedEntryBytes: ANALYZE_LIMITS.fileBytes, selectedAggregateBytes: ANALYZE_LIMITS.aggregateSvgBytes, declaredAggregateBytes: ANALYZE_LIMITS.archiveDeclaredBytes, expansionRatio: ANALYZE_LIMITS.compressionRatio, centralDirectoryBytes: 64 * 1024 * 1024, archiveFileBytes: ANALYZE_LIMITS.archiveBytes },
        onSelectedSvg: (svg) => consume(svg.entryName, svg.bytes),
      });
      totalFiles = archive.fileCount;
      if (plan.archiveIdentity === undefined || archive.snapshot.dev !== plan.archiveIdentity.dev || archive.snapshot.ino !== plan.archiveIdentity.ino || archive.snapshot.size !== plan.archiveIdentity.size || archive.snapshot.mtimeMs !== plan.archiveIdentity.mtimeMs || archive.snapshot.ctimeMs !== plan.archiveIdentity.ctimeMs) sourceFail("ANALYZE_SOURCE_CHANGED", "The archive changed between planning and analysis.");
    } catch (error) {
      if (error instanceof DiagnosticError) {
        const known = error.diagnostic.code.startsWith("ANALYZE_") ? error.diagnostic : diagnostic({ operation: "analyze", domain: "archive" }, error.diagnostic.code.includes("CHANGED") ? "ANALYZE_SOURCE_CHANGED" : "ANALYZE_ARCHIVE_INVALID", error.diagnostic.code.includes("CHANGED") ? "The archive changed during analysis." : "The ZIP archive failed safe structural validation.", error.diagnostic.location);
        throw new DiagnosticError(known);
      }
      throw new DiagnosticError(diagnostic({ operation: "analyze", domain: "archive" }, "ANALYZE_ARCHIVE_INVALID", "The ZIP archive failed safe structural validation."));
    }
  }
  results.sort((left, right) => compareUtf8(left.path, right.path));
  await verifyAnalyzeInputPlan(plan);
  return { files: results, totalFiles, sourceBytes, maxFileBytes, xmlElements };
}

export function containsAnalyzeInput(plan: AnalyzeInputPlan, target: string): boolean {
  const input = resolve(plan.inputPath); const output = resolve(target);
  if (plan.kind === "archive") return input === output;
  const rel = relative(input, output); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
