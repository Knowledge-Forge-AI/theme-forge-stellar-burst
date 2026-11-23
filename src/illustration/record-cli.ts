import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { parseDuplicateFreeJson } from "../brand/consumer-lock.js";
import { computeSha256 } from "../digests.js";
import {
  closeIllustrationDirectories,
  illustrationAbsolutePath,
  retainIllustrationDirectories,
  retainIllustrationFile,
  verifyIllustrationDirectories,
  verifyIllustrationFile,
  type RetainedIllustrationDirectory,
} from "./retained-files.js";
import {
  createRasterIllustrationRecord,
  canonicalRasterIllustrationJson,
  type RasterIllustrationRecordWithoutDigestV1,
  type RasterIllustrationRecordV1,
} from "./v1.js";
import { inspectRasterIllustrationSource, type RasterDerivativeMime, type RasterIllustrationSourceInspectionV1 } from "./derivative.js";

const RESULT_SCHEMA = "tfsb.illustration-record-result" as const;
const RESULT_SCHEMA_VERSION = 1 as const;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_SOURCE_BYTES = 32 * 1_048_576;
const MAX_JSON_DEPTH = 32;
const PRIVATE_MODE = 0o600;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const REQUEST_CONTEXT = { operation: "validate", domain: "cli" } as const;

export interface IllustrationRecordCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export type IllustrationRecordCliFailureCode =
  | "INVALID_ARGUMENTS"
  | "REQUEST_INPUT_INVALID"
  | "SOURCE_INPUT_INVALID"
  | "OUTPUT_TARGET_INVALID"
  | "OUTPUT_TARGET_EXISTS"
  | "OUTPUT_WRITE_FAILED"
  | "INTERNAL_ERROR";

interface ParsedArgs {
  readonly valid: boolean;
  readonly json: boolean;
  readonly requestPath?: string;
  readonly sourcePath?: string;
  readonly mime?: RasterDerivativeMime;
  readonly outputPath?: string;
}

interface NodeIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

type RecordMetadataInput = Omit<RasterIllustrationRecordWithoutDigestV1, "schema" | "schemaVersion" | "source">;

class IllustrationRecordCliFailure extends Error {
  readonly code: IllustrationRecordCliFailureCode;

  constructor(code: IllustrationRecordCliFailureCode) {
    super("Illustration record CLI operation failed.");
    this.name = "IllustrationRecordCliFailure";
    this.code = code;
  }
}

function fail(code: IllustrationRecordCliFailureCode): never {
  throw new IllustrationRecordCliFailure(code);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "record") return { valid: false, json: argv.includes("--json") };
  let json = false;
  let requestPath: string | undefined;
  let sourcePath: string | undefined;
  let mime: RasterDerivativeMime | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === "--json") {
      if (json) return { valid: false, json: true };
      json = true;
      continue;
    }
    if (argument.startsWith("--json=")) return { valid: false, json: true };
    const option = argument === "--request" || argument.startsWith("--request=")
      ? "request"
      : argument === "--source" || argument.startsWith("--source=")
      ? "source"
      : argument === "--mime" || argument.startsWith("--mime=")
      ? "mime"
      : argument === "--output" || argument.startsWith("--output=")
      ? "output"
      : undefined;
    if (option === undefined) return { valid: false, json };
    let value: string | undefined;
    if (argument.includes("=")) value = argument.slice(argument.indexOf("=") + 1);
    else {
      const next = rest[index + 1];
      if (next === undefined || next.length === 0 || next.startsWith("-")) return { valid: false, json };
      value = next;
      index += 1;
    }
    if (value.length === 0) return { valid: false, json };
    if (option === "request") {
      if (requestPath !== undefined) return { valid: false, json };
      requestPath = value;
    } else if (option === "source") {
      if (sourcePath !== undefined) return { valid: false, json };
      sourcePath = value;
    } else if (option === "mime") {
      if (mime !== undefined || (value !== "image/png" && value !== "image/webp")) return { valid: false, json };
      mime = value;
    } else {
      if (outputPath !== undefined) return { valid: false, json };
      outputPath = value;
    }
  }
  return {
    valid: requestPath !== undefined && sourcePath !== undefined && mime !== undefined && outputPath !== undefined,
    json,
    ...(requestPath === undefined ? {} : { requestPath }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(mime === undefined ? {} : { mime }),
    ...(outputPath === undefined ? {} : { outputPath }),
  };
}

function emit(io: IllustrationRecordCliIo, state: "completed" | "failed" | "invalid-arguments", exitCode: number, data: unknown, json: boolean): number {
  if (json) {
    io.stdout(`${JSON.stringify({ schema: RESULT_SCHEMA, schemaVersion: RESULT_SCHEMA_VERSION, command: "record", state, exitCode, data }, null, 2)}\n`);
  } else if (exitCode === 0) {
    io.stdout("Illustration record: completed.\n");
  } else {
    io.stderr(`Illustration record: ${state}${data && typeof data === "object" && "failureCode" in data && typeof data.failureCode === "string" ? ` (${data.failureCode})` : ""}; no output was published.\n`);
  }
  return exitCode;
}

function resolvedPath(cwd: string, value: unknown, code: "REQUEST_INPUT_INVALID" | "SOURCE_INPUT_INVALID" | "OUTPUT_TARGET_INVALID"): string {
  if (typeof cwd !== "string" || cwd.length === 0 || typeof value !== "string" || value.length === 0) fail(code);
  if (value.split(sep).includes("..")) fail(code);
  try {
    return illustrationAbsolutePath(resolve(cwd, value));
  } catch {
    return fail(code);
  }
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("REQUEST_INPUT_INVALID");
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) fail("REQUEST_INPUT_INVALID");
  if (Object.getOwnPropertySymbols(record).length !== 0) fail("REQUEST_INPUT_INVALID");
  for (const key of Object.getOwnPropertyNames(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail("REQUEST_INPUT_INVALID");
  }
  return record;
}

function own(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail("REQUEST_INPUT_INVALID");
  return descriptor.value;
}

function exact(record: Record<string, unknown>, required: readonly string[], optional: readonly string[]): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.getOwnPropertyNames(record).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(record, key))) fail("REQUEST_INPUT_INVALID");
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
    if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) fail("REQUEST_INPUT_INVALID");
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) fail("REQUEST_INPUT_INVALID");
    }
  }
  if (quoted || escaped || depth !== 0) fail("REQUEST_INPUT_INVALID");
}

async function readRetained(path: string, maximum: number, code: "REQUEST_INPUT_INVALID" | "SOURCE_INPUT_INVALID"): Promise<Uint8Array> {
  let directories: readonly RetainedIllustrationDirectory[] | undefined;
  let file: Awaited<ReturnType<typeof retainIllustrationFile>> | undefined;
  try {
    directories = await retainIllustrationDirectories(dirname(path));
    file = await retainIllustrationFile(path, maximum);
    await verifyIllustrationDirectories(directories);
    await verifyIllustrationFile(file);
    return new Uint8Array(file.bytes);
  } catch {
    return fail(code);
  } finally {
    await file?.handle.close().catch(() => undefined);
    if (directories !== undefined) await closeIllustrationDirectories(directories);
  }
}

function parseRequest(bytes: Uint8Array): RecordMetadataInput {
  if (bytes.byteLength > MAX_REQUEST_BYTES) fail("REQUEST_INPUT_INVALID");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("REQUEST_INPUT_INVALID");
  }
  if (text.startsWith("\uFEFF")) fail("REQUEST_INPUT_INVALID");
  assertJsonDepth(text);
  let parsed: unknown;
  try {
    parsed = parseDuplicateFreeJson(text, REQUEST_CONTEXT);
  } catch {
    fail("REQUEST_INPUT_INVALID");
  }
  const record = plainRecord(parsed);
  exact(record, ["illustrationId", "revision", "operation", "characters", "style"], ["provider", "model", "references", "lineage", "exportRecipes"]);
  const operation = own(record, "operation");
  const suppliedLineage = Object.hasOwn(record, "lineage") ? own(record, "lineage") : null;
  if (operation === "edit" && (suppliedLineage === null || suppliedLineage === undefined)) fail("REQUEST_INPUT_INVALID");
  const lineage = suppliedLineage === null || suppliedLineage === undefined ? { parentDigest: null } : suppliedLineage;
  return {
    illustrationId: own(record, "illustrationId"),
    revision: own(record, "revision"),
    operation,
    characters: own(record, "characters"),
    style: own(record, "style"),
    provider: Object.hasOwn(record, "provider") ? own(record, "provider") : null,
    model: Object.hasOwn(record, "model") ? own(record, "model") : null,
    references: Object.hasOwn(record, "references") ? own(record, "references") : [],
    lineage,
    exportRecipes: Object.hasOwn(record, "exportRecipes") ? own(record, "exportRecipes") : [],
  } as RecordMetadataInput;
}

function sourceAlpha(value: RasterIllustrationSourceInspectionV1["alpha"]): "opaque" | "straight" | "unknown" {
  return value === "has-alpha" ? "straight" : value;
}

function makeRecord(metadata: RecordMetadataInput, bytes: Uint8Array, mime: RasterDerivativeMime, inspection: RasterIllustrationSourceInspectionV1): RasterIllustrationRecordV1 {
  return createRasterIllustrationRecord({
    ...metadata,
    source: {
      sha256: computeSha256(bytes),
      mime,
      byteLength: bytes.byteLength,
      dimensions: { width: inspection.width, height: inspection.height },
      alpha: sourceAlpha(inspection.alpha),
    },
  });
}

function nodeIdentity(stat: Stats): NodeIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function sameNode(left: NodeIdentity, right: NodeIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function ownedSingle(stat: Stats): boolean {
  return stat.nlink === 1 && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

async function syncFile(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EISDIR" && code !== "EPERM") throw error;
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) fail("OUTPUT_WRITE_FAILED");
    offset += result.bytesWritten;
  }
}

async function readBack(handle: FileHandle, maximum: number): Promise<Buffer> {
  const bytes = Buffer.alloc(maximum);
  let offset = 0;
  while (offset < maximum) {
    const result = await handle.read(bytes, offset, maximum - offset, offset);
    if (result.bytesRead <= 0) fail("OUTPUT_WRITE_FAILED");
    offset += result.bytesRead;
  }
  return bytes;
}

async function publishOutput(path: string, bytes: Uint8Array): Promise<void> {
  let directories: readonly RetainedIllustrationDirectory[] | undefined;
  let handle: FileHandle | undefined;
  let createdIdentity: NodeIdentity | undefined;
  try {
    directories = await retainIllustrationDirectories(dirname(path));
    const parent = directories.at(-1);
    if (parent === undefined) fail("OUTPUT_TARGET_INVALID");
    try {
      handle = await open(path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, PRIVATE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("OUTPUT_TARGET_EXISTS");
      throw error;
    }
    await handle.chmod(PRIVATE_MODE);
    const created = await handle.stat();
    createdIdentity = nodeIdentity(created);
    if (!created.isFile() || created.isSymbolicLink() || !ownedSingle(created) || (created.mode & 0o7777) !== PRIVATE_MODE) fail("OUTPUT_WRITE_FAILED");
    await verifyIllustrationDirectories(directories);
    await writeAll(handle, bytes);
    await syncFile(handle);
    const written = await handle.stat();
    if (!written.isFile() || !ownedSingle(written) || written.size !== bytes.byteLength || (written.mode & 0o7777) !== PRIVATE_MODE || !sameNode(createdIdentity, nodeIdentity(written))) fail("OUTPUT_WRITE_FAILED");
    const readback = await readBack(handle, bytes.byteLength);
    if (Buffer.compare(readback, Buffer.from(bytes)) !== 0 || computeSha256(readback) !== computeSha256(bytes)) fail("OUTPUT_WRITE_FAILED");
    await handle.close();
    handle = undefined;
    const after = await lstat(path).catch(() => undefined);
    if (after === undefined || after.isSymbolicLink() || !after.isFile() || !ownedSingle(after) || !sameNode(createdIdentity, nodeIdentity(after))) fail("OUTPUT_WRITE_FAILED");
    await verifyIllustrationDirectories(directories);
    await syncFile(parent.handle);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (createdIdentity !== undefined) {
      const current = await lstat(path).catch(() => undefined);
      if (current !== undefined && current.isFile() && !current.isSymbolicLink() && ownedSingle(current) && sameNode(createdIdentity, nodeIdentity(current))) await unlink(path).catch(() => undefined);
    }
    if (error instanceof IllustrationRecordCliFailure) throw error;
    throw new IllustrationRecordCliFailure("OUTPUT_WRITE_FAILED");
  } finally {
    if (directories !== undefined) await closeIllustrationDirectories(directories);
  }
}

function failureCode(error: unknown): IllustrationRecordCliFailureCode {
  if (error instanceof IllustrationRecordCliFailure) return error.code;
  return "INTERNAL_ERROR";
}

export async function runIllustrationRecordCli(argv: readonly string[], cwd: string, io: IllustrationRecordCliIo): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.valid) return emit(io, "invalid-arguments", 1, { failureCode: "INVALID_ARGUMENTS" }, parsed.json);
  try {
    const requestPath = resolvedPath(cwd, parsed.requestPath, "REQUEST_INPUT_INVALID");
    const sourcePath = resolvedPath(cwd, parsed.sourcePath, "SOURCE_INPUT_INVALID");
    const outputPath = resolvedPath(cwd, parsed.outputPath, "OUTPUT_TARGET_INVALID");
    const metadata = parseRequest(await readRetained(requestPath, MAX_REQUEST_BYTES, "REQUEST_INPUT_INVALID"));
    const sourceBytes = await readRetained(sourcePath, MAX_SOURCE_BYTES, "SOURCE_INPUT_INVALID");
    let inspection: RasterIllustrationSourceInspectionV1;
    try {
      inspection = inspectRasterIllustrationSource(sourceBytes, parsed.mime!);
    } catch {
      fail("SOURCE_INPUT_INVALID");
    }
    let record: RasterIllustrationRecordV1;
    let canonical: Buffer;
    try {
      record = makeRecord(metadata, sourceBytes, parsed.mime!, inspection);
      canonical = Buffer.from(canonicalRasterIllustrationJson(record), "utf8");
    } catch {
      fail("REQUEST_INPUT_INVALID");
    }
    await publishOutput(outputPath, canonical);
    return emit(io, "completed", 0, {
      record,
      recordDigest: record.digest,
      source: {
        sha256: record.source.sha256,
        mime: record.source.mime,
        byteLength: record.source.byteLength,
        dimensions: record.source.dimensions,
        alpha: record.source.alpha,
        verification: inspection.verification,
      },
      metadataOnly: true,
      providerAttested: false,
    }, parsed.json);
  } catch (error) {
    return emit(io, "failed", 1, { failureCode: failureCode(error) }, parsed.json);
  }
}
