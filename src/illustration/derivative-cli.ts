import { constants, type Stats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { parseDuplicateFreeJson } from "../brand/consumer-lock.js";
import { computeSha256 } from "../digests.js";
import { canonicalJson } from "../service-protocol/canonical-json.js";
import {
  DERIVATIVE_LIMITS,
  probeMagickDerivativeCapability,
  renderRasterDerivative,
  renderSceneWebp,
  verifyRasterDerivativeOutput,
  type RasterDerivativeReceiptV1,
  validateRasterDerivativeRecipe,
  type DerivativeCapabilityStatus,
  type RasterDerivativeFailureCode,
  type RasterDerivativeOutputV1,
  type RasterDerivativeRecipeV1,
} from "./derivative.js";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const PRIVATE_MODE = 0o600;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_RECIPE_JSON_DEPTH = 32;
const DERIVATIVE_RESULT_SCHEMA = "tfsb.illustration-derivative-result" as const;
const DERIVATIVE_RESULT_SCHEMA_VERSION = 1 as const;

export interface IllustrationDerivativeCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Internal unit-test seam; normal routing uses the three-argument handler. */
export interface IllustrationDerivativeCliRuntime {
  readonly probe?: () => Promise<DerivativeCapabilityStatus>;
  readonly render?: (sourceBytes: Uint8Array, recipe: RasterDerivativeRecipeV1) => Promise<RasterDerivativeOutputV1>;
}

export type IllustrationDerivativeCliReceiptV1 = RasterDerivativeReceiptV1;

type CliCommand = "capability" | "export";
type CliEnvelopeCommand = CliCommand | "request";
type CliState = "available" | "unavailable" | "completed" | "failed" | "invalid-arguments";
type CliFailureCode =
  | "INVALID_ARGUMENTS"
  | "RECIPE_INPUT_INVALID"
  | "SOURCE_INPUT_INVALID"
  | "OUTPUT_TARGET_INVALID"
  | "OUTPUT_TARGET_EXISTS"
  | "OUTPUT_WRITE_FAILED"
  | "INTERNAL_ERROR"
  | RasterDerivativeFailureCode;

const CLI_FAILURE_CODES: ReadonlySet<string> = new Set([
  "INVALID_ARGUMENTS",
  "RECIPE_INPUT_INVALID",
  "SOURCE_INPUT_INVALID",
  "OUTPUT_TARGET_INVALID",
  "OUTPUT_TARGET_EXISTS",
  "OUTPUT_WRITE_FAILED",
  "INTERNAL_ERROR",
  "INVALID_RECIPE",
  "SOURCE_INVALID",
  "SOURCE_CHECKSUM_MISMATCH",
  "PROCESSOR_UNAVAILABLE",
  "PROCESSOR_MISMATCH",
  "PROCESS_FAILED",
  "OUTPUT_INVALID",
  "PROCESS_TIMEOUT",
  "PROCESS_OUTPUT_LIMIT",
]);

class DerivativeCliFailure extends Error {
  readonly code: CliFailureCode;

  constructor(code: CliFailureCode) {
    super("Illustration derivative CLI operation failed.");
    this.name = "DerivativeCliFailure";
    this.code = code;
  }
}

interface ParsedArgs {
  readonly command: CliCommand | null;
  readonly json: boolean;
  readonly recipePath?: string;
  readonly sourcePath?: string;
  readonly outputPath?: string;
  readonly valid: boolean;
}

interface NodeIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

interface SnapshotIdentity extends NodeIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface OutputParent {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: NodeIdentity;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv;
  const command = rawCommand === "capability" || rawCommand === "export" ? rawCommand : null;
  let json = false;
  let recipePath: string | undefined;
  let sourcePath: string | undefined;
  let outputPath: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === "--json") {
      if (json) return { command, json: true, valid: false };
      json = true;
      continue;
    }
    if (argument.startsWith("--json=")) return { command, json: true, valid: false };

    const option = argument === "--recipe" || argument.startsWith("--recipe=")
      ? "recipePath"
      : argument === "--source" || argument.startsWith("--source=")
      ? "sourcePath"
      : argument === "--output" || argument.startsWith("--output=")
      ? "outputPath"
      : null;
    if (option === null) {
      if (argument.startsWith("-")) return { command, json, valid: false };
      positionals.push(argument);
      continue;
    }

    let value: string | undefined;
    if (argument.includes("=")) value = argument.slice(argument.indexOf("=") + 1);
    else {
      const next = rest[index + 1];
      if (next === undefined || next.length === 0 || next.startsWith("-")) return { command, json, valid: false };
      value = next;
      index += 1;
    }
    if (value.length === 0) return { command, json, valid: false };
    if (option === "recipePath") {
      if (recipePath !== undefined) return { command, json, valid: false };
      recipePath = value;
    } else if (option === "sourcePath") {
      if (sourcePath !== undefined) return { command, json, valid: false };
      sourcePath = value;
    } else {
      if (outputPath !== undefined) return { command, json, valid: false };
      outputPath = value;
    }
  }

  if (command === null || positionals.length !== 0) return { command, json, valid: false };
  if (command === "capability") {
    return { command, json, valid: recipePath === undefined && sourcePath === undefined && outputPath === undefined };
  }
  return {
    command,
    json,
    ...(recipePath === undefined ? {} : { recipePath }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    valid: recipePath !== undefined && sourcePath !== undefined && outputPath !== undefined,
  };
}

function emit(
  io: IllustrationDerivativeCliIo,
  command: CliEnvelopeCommand,
  state: CliState,
  exitCode: number,
  data: unknown,
  json: boolean,
): number {
  if (json) {
    io.stdout(`${JSON.stringify({ schema: DERIVATIVE_RESULT_SCHEMA, schemaVersion: DERIVATIVE_RESULT_SCHEMA_VERSION, command, state, exitCode, data }, null, 2)}\n`);
  } else if (exitCode === 0 && command === "capability") {
    io.stdout(`Illustration derivative capability: ${state}.\n`);
  } else if (exitCode === 0) {
    io.stdout("Illustration derivative export: completed.\n");
  } else {
    const failureCode = data && typeof data === "object" && "failureCode" in data && typeof data.failureCode === "string" ? ` (${data.failureCode})` : "";
    io.stderr(`Illustration derivative ${command === "request" ? "request" : command}: ${state}${failureCode}.\n`);
  }
  return exitCode;
}

function identity(stat: Stats): NodeIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function snapshotIdentity(stat: Stats): SnapshotIdentity {
  return { ...identity(stat), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameNode(left: NodeIdentity, right: NodeIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameSnapshot(left: SnapshotIdentity, right: SnapshotIdentity): boolean {
  return sameNode(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isCurrentUserOwned(stat: Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function fail(code: CliFailureCode): never {
  throw new DerivativeCliFailure(code);
}

function resolvedPath(cwd: string, value: string, code: "RECIPE_INPUT_INVALID" | "SOURCE_INPUT_INVALID" | "OUTPUT_TARGET_INVALID"): string {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0") || value.length === 0 || value.includes("\0")) fail(code);
  try {
    return resolve(cwd, value);
  } catch {
    fail(code);
  }
}

async function validateDirectoryComponents(path: string, code: "RECIPE_INPUT_INVALID" | "SOURCE_INPUT_INVALID" | "OUTPUT_TARGET_INVALID"): Promise<void> {
  const root = path.startsWith(sep) ? sep : path.slice(0, 3);
  let cursor = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor).catch(() => undefined);
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) fail(code);
  }
}

async function readBoundedNoFollow(path: string, maximum: number, code: "RECIPE_INPUT_INVALID" | "SOURCE_INPUT_INVALID"): Promise<Uint8Array> {
  await validateDirectoryComponents(dirname(path), code);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const openedBefore = await handle.stat();
    const namedBefore = await lstat(path);
    if (!openedBefore.isFile() || !namedBefore.isFile() || namedBefore.isSymbolicLink() || openedBefore.size > maximum
      || !sameSnapshot(snapshotIdentity(namedBefore), snapshotIdentity(openedBefore))) fail(code);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = maximum - total;
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(1, remaining + 1)));
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > maximum) fail(code);
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    const openedAfter = await handle.stat();
    const namedAfter = await lstat(path).catch(() => undefined);
    if (namedAfter === undefined || namedAfter.isSymbolicLink() || !namedAfter.isFile() || !sameSnapshot(snapshotIdentity(openedBefore), snapshotIdentity(openedAfter)) || !sameSnapshot(snapshotIdentity(openedAfter), snapshotIdentity(namedAfter)) || total !== openedBefore.size) fail(code);
    return new Uint8Array(Buffer.concat(chunks, total));
  } catch (error) {
    if (error instanceof DerivativeCliFailure) throw error;
    return fail(code);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function assertJsonDepth(source: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_RECIPE_JSON_DEPTH) fail("RECIPE_INPUT_INVALID");
    } else if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
  }
}

async function readRecipe(path: string): Promise<RasterDerivativeRecipeV1> {
  const bytes = await readBoundedNoFollow(path, DERIVATIVE_LIMITS.recipeBytes, "RECIPE_INPUT_INVALID");
  if (hasUtf8Bom(bytes)) fail("RECIPE_INPUT_INVALID");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("RECIPE_INPUT_INVALID");
  }
  if (text.startsWith("\uFEFF")) fail("RECIPE_INPUT_INVALID");
  assertJsonDepth(text);
  let parsed: unknown;
  try {
    parsed = parseDuplicateFreeJson(text, { operation: "validate", domain: "cli" });
  } catch {
    fail("RECIPE_INPUT_INVALID");
  }
  try {
    return validateRasterDerivativeRecipe(parsed);
  } catch {
    fail("RECIPE_INPUT_INVALID");
  }
}

async function openOutputParent(path: string): Promise<OutputParent> {
  await validateDirectoryComponents(dirname(path), "OUTPUT_TARGET_INVALID");
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW | NONBLOCK);
    const opened = await handle.stat();
    const named = await lstat(path);
    if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || !sameNode(identity(named), identity(opened))) fail("OUTPUT_TARGET_INVALID");
    return { path, handle, identity: identity(opened) };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof DerivativeCliFailure) throw error;
    fail("OUTPUT_TARGET_INVALID");
  }
}

async function assertOutputAbsent(path: string): Promise<void> {
  const parent = await openOutputParent(dirname(path));
  try {
    if (await lstat(path).catch(() => undefined) !== undefined) fail("OUTPUT_TARGET_EXISTS");
    const current = await lstat(parent.path).catch(() => undefined);
    if (current === undefined || current.isSymbolicLink() || !current.isDirectory() || !sameNode(parent.identity, identity(current))) fail("OUTPUT_TARGET_INVALID");
  } finally {
    await parent.handle.close().catch(() => undefined);
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (written.bytesWritten <= 0) throw new Error("short write");
    offset += written.bytesWritten;
  }
}

async function unlinkOwned(path: string, expected: NodeIdentity): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  if (current !== undefined && current.isFile() && !current.isSymbolicLink() && sameNode(expected, identity(current))) await unlink(path).catch(() => undefined);
}

async function syncDirectory(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EINVAL" && code !== "EISDIR")) throw error;
  }
}

async function publishOutput(path: string, bytes: Uint8Array): Promise<void> {
  const parent = await openOutputParent(dirname(path));
  let handle: FileHandle | undefined;
  let outputIdentity: NodeIdentity | undefined;
  try {
    try {
      handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, PRIVATE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("OUTPUT_TARGET_EXISTS");
      throw error;
    }
    await handle.chmod(PRIVATE_MODE);
    const created = await handle.stat();
    outputIdentity = identity(created);
    if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1 || !isCurrentUserOwned(created) || (created.mode & 0o777) !== PRIVATE_MODE) fail("OUTPUT_WRITE_FAILED");
    const parentAfterCreate = await lstat(parent.path).catch(() => undefined);
    if (parentAfterCreate === undefined || parentAfterCreate.isSymbolicLink() || !parentAfterCreate.isDirectory() || !sameNode(parent.identity, identity(parentAfterCreate))) fail("OUTPUT_TARGET_INVALID");
    await writeAll(handle, bytes);
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1 || !isCurrentUserOwned(written) || written.size !== bytes.byteLength || (written.mode & 0o777) !== PRIVATE_MODE || !sameNode(outputIdentity, identity(written))) fail("OUTPUT_WRITE_FAILED");
    const verified = Buffer.alloc(bytes.byteLength);
    let read = 0;
    while (read < verified.byteLength) {
      const result = await handle.read(verified, read, verified.byteLength - read, read);
      if (result.bytesRead <= 0) fail("OUTPUT_WRITE_FAILED");
      read += result.bytesRead;
    }
    if (Buffer.compare(verified, Buffer.from(bytes)) !== 0 || computeSha256(verified) !== computeSha256(bytes)) fail("OUTPUT_WRITE_FAILED");
    await handle.close();
    handle = undefined;
    const targetAfter = await lstat(path).catch(() => undefined);
    const parentAfter = await lstat(parent.path).catch(() => undefined);
    if (targetAfter === undefined || targetAfter.isSymbolicLink() || !targetAfter.isFile() || targetAfter.nlink !== 1 || !isCurrentUserOwned(targetAfter) || !sameNode(outputIdentity, identity(targetAfter)) || parentAfter === undefined || parentAfter.isSymbolicLink() || !parentAfter.isDirectory() || !sameNode(parent.identity, identity(parentAfter))) fail("OUTPUT_TARGET_INVALID");
    await syncDirectory(parent.handle);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (outputIdentity !== undefined) await unlinkOwned(path, outputIdentity);
    if (error instanceof DerivativeCliFailure) throw error;
    fail("OUTPUT_WRITE_FAILED");
  } finally {
    await parent.handle.close().catch(() => undefined);
  }
}

function failureCode(error: unknown): CliFailureCode {
  if (error instanceof DerivativeCliFailure) return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string" && CLI_FAILURE_CODES.has(error.code)) return error.code as CliFailureCode;
  return "INTERNAL_ERROR";
}

async function publishDerivative(
  source: Uint8Array, recipe: RasterDerivativeRecipeV1, outputPath: string,
  render: NonNullable<IllustrationDerivativeCliRuntime["render"]>,
): Promise<IllustrationDerivativeCliReceiptV1> {
  await assertOutputAbsent(outputPath);
  const output = await render(source, recipe);
  const receipt = verifyRasterDerivativeOutput(output, recipe);
  await publishOutput(outputPath, output.bytes);
  return receipt;
}

/** Encode a reviewed scene's in-memory PNG with the standard illustration WebP recipe. */
export async function exportSceneWebp(
  source: Uint8Array, width: number, height: number, output: string, cwd: string,
): Promise<
  | { readonly ok: true; readonly recipe: RasterDerivativeRecipeV1; readonly receipt: IllustrationDerivativeCliReceiptV1 }
  | { readonly ok: false; readonly code: string }
> {
  try {
    const outputPath = resolvedPath(cwd, output, "OUTPUT_TARGET_INVALID");
    await assertOutputAbsent(outputPath);
    const { recipe, output: encoded, receipt } = await renderSceneWebp(source, width, height);
    await publishOutput(outputPath, encoded.bytes);
    return { ok: true, recipe, receipt };
  } catch (error) {
    return { ok: false, code: failureCode(error) };
  }
}

export async function runIllustrationDerivativeCli(
  argv: readonly string[],
  cwd: string,
  io: IllustrationDerivativeCliIo,
  runtime: IllustrationDerivativeCliRuntime = {},
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.valid || parsed.command === null) return emit(io, parsed.command ?? "request", "invalid-arguments", 1, { failureCode: "INVALID_ARGUMENTS" }, parsed.json);
  if (parsed.command === "capability") {
    let capability: DerivativeCapabilityStatus;
    try {
      capability = await (runtime.probe ?? probeMagickDerivativeCapability)();
    } catch {
      return emit(io, "capability", "unavailable", 0, { available: false, code: "DERIVATIVE_PROCESSOR_UNAVAILABLE" }, parsed.json);
    }
    if (!capability.available) return emit(io, "capability", "unavailable", 0, { available: false, code: capability.code }, parsed.json);
    return emit(io, "capability", "available", 0, { available: true, processor: capability.processor }, parsed.json);
  }

  try {
    const recipePath = resolvedPath(cwd, parsed.recipePath!, "RECIPE_INPUT_INVALID");
    const sourcePath = resolvedPath(cwd, parsed.sourcePath!, "SOURCE_INPUT_INVALID");
    const outputPath = resolvedPath(cwd, parsed.outputPath!, "OUTPUT_TARGET_INVALID");
    const recipe = await readRecipe(recipePath);
    const source = await readBoundedNoFollow(sourcePath, DERIVATIVE_LIMITS.sourceBytes, "SOURCE_INPUT_INVALID");
    const receipt = await publishDerivative(source, recipe, outputPath, runtime.render ?? renderRasterDerivative);
    return emit(io, "export", "completed", 0, receipt, parsed.json);
  } catch (error) {
    return emit(io, "export", "failed", 1, { failureCode: failureCode(error) }, parsed.json);
  }
}
