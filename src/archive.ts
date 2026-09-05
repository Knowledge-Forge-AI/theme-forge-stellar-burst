import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { inflateSync } from "fflate";

import { ARCHIVE_LIMITS, mutationAggregateBytesExceedsLimit, mutationSvgCountExceedsLimit } from "./archive-limits.js";
import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";
import { computeRawSha256, type Sha256Digest } from "./digests.js";
import { readExactBuffer } from "./filesystem.js";
import {
  BUNDLE_MANIFEST_FILENAME,
  parseBundleManifest,
  unwrapBundleManifest,
  type AnyBundleManifest,
  type BundleManifestAssetRecord,
  type BundleManifestCompanionRecord,
  type BundleManifestGenerator,
  type BundleManifestV1,
} from "./manifest.js";
import type { AssetId } from "./types.js";

export { ARCHIVE_LIMITS } from "./archive-limits.js";

export const ALLOWED_COMPANION_EXTENSIONS = [".md", ".markdown", ".txt"] as const;
export const ALLOWED_COMPANION_BASE_NAMES = new Set([
  "license",
  "licence",
  "notice",
  "copying",
  "copyright",
]);

export function isAllowedCompanionFilename(name: string): boolean {
  const leaf = (name.split("/").pop() ?? name).toLowerCase();
  for (const ext of ALLOWED_COMPANION_EXTENSIONS) {
    if (leaf.endsWith(ext)) return true;
  }
  return ALLOWED_COMPANION_BASE_NAMES.has(leaf);
}

interface CentralEntry {
  readonly name: string;
  readonly portableKey: string;
  readonly directory: boolean;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export interface SelectedArchiveSvg {
  readonly entryName: string;
  readonly bytes: Uint8Array;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

function archiveContext(source: string, operation: DiagnosticContext["operation"] = "import"): DiagnosticContext {
  return { operation, domain: "archive", source };
}

function invalid(ctx: DiagnosticContext, message: string, location?: string): never {
  fail(ctx, "ARCHIVE_INVALID_ZIP", message, location);
}

async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
  ctx: DiagnosticContext,
  maxLimit: number = ARCHIVE_LIMITS.centralDirectoryBytes,
): Promise<Buffer> {
  return readExactBuffer(handle, length, position, ctx, maxLimit, "ARCHIVE_INVALID_ZIP", "ZIP structure is truncated.");
}

function decodeEntryName(bytes: Uint8Array, utf8Flag: boolean, ctx: DiagnosticContext): string {
  if (!utf8Flag && bytes.some((byte) => byte > 0x7f)) {
    invalid(ctx, "Non-ASCII ZIP entry names must carry the UTF-8 flag.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).normalize("NFC");
  } catch {
    invalid(ctx, "ZIP entry name is not valid UTF-8.");
  }
}

function normalizeEntryName(
  name: string,
  directory: boolean,
  ctx: DiagnosticContext,
): { readonly name: string; readonly key: string } {
  if (
    name === "" ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.startsWith("//")
  ) {
    fail(ctx, "ARCHIVE_UNSAFE_PATH", `Unsafe archive entry name '${name}'.`, name);
  }
  const normalized = directory && name.endsWith("/") ? name.slice(0, -1) : name;
  const segments = normalized.split("/");
  if (
    normalized === "" ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(ctx, "ARCHIVE_UNSAFE_PATH", `Unsafe archive entry name '${name}'.`, name);
  }
  const portable = segments
    .map((segment) => segment.replace(/[A-Z]/g, (letter) => letter.toLowerCase()))
    .join("/");
  return { name: directory ? `${normalized}/` : normalized, key: portable };
}

function classifyEntry(
  name: string,
  madeBy: number,
  externalAttributes: number,
  ctx: DiagnosticContext,
): boolean {
  const madeByOs = madeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  const unixType = unixMode & 0o170000;
  const directoryByName = name.endsWith("/");
  const directoryByDos = (externalAttributes & 0x10) !== 0;
  const directory = directoryByName || directoryByDos || unixType === 0o040000;
  if (unixType === 0o120000) {
    fail(ctx, "ARCHIVE_UNSAFE_TYPE", `Symlink entry '${name}' is not allowed.`, name);
  }
  if (madeByOs === 3 && unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
    fail(ctx, "ARCHIVE_UNSAFE_TYPE", `Non-regular entry '${name}' is not allowed.`, name);
  }
  if (directory && !directoryByName) {
    fail(ctx, "ARCHIVE_UNSAFE_TYPE", `Directory entry '${name}' must end in '/'.`, name);
  }
  if (!directory && directoryByName) {
    fail(ctx, "ARCHIVE_UNSAFE_TYPE", `Entry type for '${name}' is ambiguous.`, name);
  }
  return directory;
}

function parseCentralDirectory(buffer: Buffer, count: number, ctx: DiagnosticContext): readonly CentralEntry[] {
  const entries: CentralEntry[] = [];
  const seen = new Map<string, string>();
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      invalid(ctx, "Invalid ZIP central-directory record.");
    }
    const madeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const disk = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length || disk !== 0) invalid(ctx, "Unsupported multi-disk or truncated ZIP archive.");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      invalid(ctx, "ZIP64 entries are not supported by the bounded v0.1 importer.");
    }
    const rawName = decodeEntryName(
      buffer.subarray(offset + 46, offset + 46 + nameLength),
      (flags & 0x0800) !== 0,
      ctx,
    );
    if ((flags & 0x0001) !== 0) {
      fail(ctx, "ARCHIVE_ENCRYPTED", `Encrypted entry '${rawName}' is not allowed.`, rawName);
    }
    const directory = classifyEntry(rawName, madeBy, externalAttributes, ctx);
    const normalized = normalizeEntryName(rawName, directory, ctx);
    const previous = seen.get(normalized.key);
    if (previous !== undefined) {
      fail(
        ctx,
        "ARCHIVE_COLLISION",
        `Archive entries '${previous}' and '${normalized.name}' have the same portable name.`,
        normalized.name,
      );
    }
    seen.set(normalized.key, normalized.name);
    entries.push({
      name: normalized.name,
      portableKey: normalized.key,
      directory,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset = end;
  }
  if (offset !== buffer.length) invalid(ctx, "ZIP central directory has trailing or missing records.");
  return entries;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function readEntry(
  handle: FileHandle,
  entry: CentralEntry,
  fileSize: number,
  ctx: DiagnosticContext,
  entryLimit = ARCHIVE_LIMITS.selectedEntryBytes,
): Promise<Uint8Array> {
  if (entry.compressedSize > entryLimit) {
    fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", `Selected entry '${entry.name}' exceeds archive limits.`, entry.name);
  }
  if (entry.localHeaderOffset + 30 > fileSize) {
    invalid(ctx, "ZIP local-file header offset exceeds archive bounds.", entry.name);
  }
  const header = await readExactly(handle, 30, entry.localHeaderOffset, ctx);
  if (header.readUInt32LE(0) !== 0x04034b50) invalid(ctx, "Invalid ZIP local-file header.", entry.name);
  const localFlags = header.readUInt16LE(6);
  const localMethod = header.readUInt16LE(8);
  if (localFlags !== entry.flags || localMethod !== entry.method) {
    invalid(ctx, "ZIP local and central metadata disagree.", entry.name);
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > fileSize) {
    invalid(ctx, "ZIP entry data offset exceeds archive bounds.", entry.name);
  }
  const compressed = await readExactly(handle, entry.compressedSize, dataOffset, ctx);
  let inflated: Uint8Array;
  try {
    if (entry.method === 0) inflated = compressed;
    else if (entry.method === 8) {
      inflated = inflateSync(compressed, {
        out: new Uint8Array(Math.min(entry.uncompressedSize + 1, entryLimit + 1)),
      });
    } else {
      fail(
        ctx,
        "ARCHIVE_UNSUPPORTED_COMPRESSION",
        `Selected entry '${entry.name}' uses unsupported compression method ${entry.method}.`,
        entry.name,
      );
    }
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    invalid(ctx, `Selected entry '${entry.name}' cannot be decompressed.`, entry.name);
  }
  if (
    inflated.length !== entry.uncompressedSize ||
    inflated.length > entryLimit
  ) {
    fail(
      ctx,
      "ARCHIVE_LIMIT_EXCEEDED",
      `Selected entry '${entry.name}' exceeds or disagrees with its declared size.`,
      entry.name,
    );
  }
  if (crc32(inflated) !== entry.crc32) invalid(ctx, `CRC mismatch for '${entry.name}'.`, entry.name);
  return inflated;
}

export interface SelectedArchiveCompanion {
  readonly entryName: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface ArchiveReadResult {
  readonly svgs: readonly SelectedArchiveSvg[];
  readonly companions: readonly SelectedArchiveCompanion[];
  readonly archiveDigest: Sha256Digest;
  readonly snapshot: ArchiveSnapshot;
  readonly entryCount: number;
  readonly fileCount: number;
}

export interface ArchiveReadOptions {
  readonly selectAllSvgs?: boolean;
  readonly selectAllCompanions?: boolean;
  readonly allowNoSvgs?: boolean;
  readonly operation?: "import" | "reconcile" | "diff" | "analyze";
  readonly hooks?: ArchiveReadHooks;
  readonly limits?: ArchiveReadLimits;
  readonly retainSelectedSvgs?: boolean;
  readonly onSelectedSvg?: (svg: SelectedArchiveSvg) => void | Promise<void>;
}

export interface ArchiveReadLimits {
  readonly totalEntries: number;
  readonly selectedSvgEntries: number;
  readonly selectedEntryBytes: number;
  readonly selectedAggregateBytes: number;
  readonly declaredAggregateBytes?: number;
  readonly expansionRatio: number;
  readonly centralDirectoryBytes: number;
  readonly archiveFileBytes: number;
}

export interface ArchiveReadHooks {
  readonly afterStructure?: () => void | Promise<void>;
  readonly beforeHash?: () => void | Promise<void>;
  readonly onHashChunk?: () => void | Promise<void>;
  readonly beforeSelectedEntryInspection?: () => void | Promise<void>;
}

export interface ArchiveSnapshot {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function archiveSnapshot(path: string, stat: Stats): ArchiveSnapshot {
  return { path, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameSnapshot(left: ArchiveSnapshot, right: ArchiveSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function hashOpenArchive(
  handle: FileHandle,
  size: number,
  ctx: DiagnosticContext,
  hooks?: ArchiveReadHooks,
): Promise<Sha256Digest> {
  await hooks?.beforeHash?.();
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < size) {
    const length = Math.min(chunk.length, size - position);
    let chunkRead = 0;
    while (chunkRead < length) {
      const { bytesRead } = await handle.read(chunk, chunkRead, length - chunkRead, position + chunkRead);
      if (bytesRead === 0) invalid(ctx, "Archive changed or became truncated while hashing.");
      chunkRead += bytesRead;
    }
    hash.update(chunk.subarray(0, length));
    position += length;
    await hooks?.onHashChunk?.();
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function verifyArchiveSnapshot(
  snapshot: ArchiveSnapshot,
  operation: DiagnosticContext["operation"] = "reconcile",
): Promise<void> {
  const stat = await lstat(snapshot.path).catch(() => undefined);
  if (
    stat === undefined ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !sameSnapshot(snapshot, archiveSnapshot(snapshot.path, stat))
  ) {
    fail(
      archiveContext(snapshot.path, operation),
      "ARCHIVE_CHANGED_DURING_PLAN",
      "Archive changed between planning and extraction.",
    );
  }
}

export async function readArchive(
  archivePath: string,
  svgSelections: readonly string[] = [],
  companionSelections: readonly string[] = [],
  options: ArchiveReadOptions = {},
): Promise<ArchiveReadResult> {
  const ctx = archiveContext(archivePath, options.operation ?? "import");
  const limits: ArchiveReadLimits = options.limits ?? ARCHIVE_LIMITS;
  let handle: FileHandle | undefined;
  try {
    const pathStat = await lstat(archivePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      fail(ctx, "ARCHIVE_READ_FAILED", "Archive must be a non-symlink regular file.");
    }
    handle = await open(archivePath, "r");
    const stat = await handle.stat();
    const snapshot = archiveSnapshot(archivePath, stat);
    if (!sameSnapshot(snapshot, archiveSnapshot(archivePath, pathStat))) {
      fail(ctx, "ARCHIVE_CHANGED_DURING_PLAN", "Archive changed while it was opened.");
    }
    if (stat.size > limits.archiveFileBytes) {
      if (options.operation === "analyze") {
        fail(ctx, "ANALYZE_ARCHIVE_BYTE_LIMIT_EXCEEDED", "The ZIP exceeds the fixed 512 MiB raw archive limit.");
      }
      fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Archive exceeds the fixed 128 MiB raw-file limit.");
    }
    const tailLength = Math.min(stat.size, 65_557);
    const tail = await readExactly(handle, tailLength, stat.size - tailLength, ctx);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) invalid(ctx, "ZIP end-of-central-directory record is missing.");
    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    const diskEntries = tail.readUInt16LE(eocd + 8);
    const totalEntries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    const commentLength = tail.readUInt16LE(eocd + 20);
    if (eocd + 22 + commentLength !== tail.length || disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      invalid(ctx, "Unsupported multi-disk or malformed ZIP archive.");
    }
    if (totalEntries > limits.totalEntries) {
      if (options.operation === "analyze") {
        fail(ctx, "ANALYZE_CANDIDATE_LIMIT_EXCEEDED", "The input exceeds the fixed 100,000-candidate limit.");
      }
      fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Archive contains more than 1,024 entries.");
    }
    if (centralSize > limits.centralDirectoryBytes || centralOffset + centralSize > stat.size) {
      fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "ZIP central directory exceeds the bounded importer limit.");
    }
    const entries = parseCentralDirectory(
      await readExactly(handle, centralSize, centralOffset, ctx),
      totalEntries,
      ctx,
    );
    await options.hooks?.afterStructure?.();
    const archiveDigest = await hashOpenArchive(handle, stat.size, ctx, options.hooks);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const selectedSvgEntries =
      options.selectAllSvgs === true || (options.selectAllSvgs === undefined && svgSelections.length === 0)
        ? entries.filter((entry) => !entry.directory && entry.name.toLowerCase().endsWith(".svg"))
        : [...new Set(svgSelections)].map((selection) => {
            const normalized = normalizeEntryName(selection.normalize("NFC"), false, ctx).name;
            const entry = byName.get(normalized);
            if (entry === undefined || entry.directory) {
              fail(ctx, "ARCHIVE_SELECTION_MISSING", `Selected entry '${selection}' does not exist.`, selection);
            }
            if (!entry.name.toLowerCase().endsWith(".svg")) {
              fail(ctx, "ARCHIVE_SELECTION_UNSUPPORTED", `Selected entry '${selection}' is not an SVG.`, selection);
            }
            return entry;
          });
    if (options.operation === "analyze") selectedSvgEntries.sort((left, right) => Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
    if (selectedSvgEntries.length === 0 && options.allowNoSvgs !== true) {
      fail(ctx, "ARCHIVE_SELECTION_EMPTY", "Archive selection contains no SVG entries.");
    }
    if (options.operation === "analyze" ? selectedSvgEntries.length > limits.selectedSvgEntries : mutationSvgCountExceedsLimit(selectedSvgEntries.length)) {
      if (options.operation === "analyze") {
        fail(ctx, "ANALYZE_SVG_FILE_LIMIT_EXCEEDED", "The input exceeds the fixed 50,000-SVG limit.");
      }
      fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Archive selects more than 128 SVG entries.");
    }

    const uniqueCompanionSelections = [...new Set(companionSelections)];
    const selectedCompanionEntries = options.selectAllCompanions === true
      ? entries.filter((entry) => !entry.directory && isAllowedCompanionFilename(entry.name))
      : uniqueCompanionSelections.map((selection) => {
      const normalized = normalizeEntryName(selection.normalize("NFC"), false, ctx).name;
      const entry = byName.get(normalized);
      if (entry === undefined || entry.directory) {
        fail(ctx, "ARCHIVE_SELECTION_MISSING", `Selected companion '${selection}' does not exist.`, selection);
      }
      if (!isAllowedCompanionFilename(entry.name)) {
        fail(
          ctx,
          "ARCHIVE_COMPANION_UNSUPPORTED",
          `Selected companion '${selection}' is not a supported companion document type.`,
          selection,
        );
      }
          return entry;
        });

    const allSelected = [...selectedSvgEntries, ...selectedCompanionEntries];
    if (options.operation === "analyze") {
      const declaredEntries = entries.filter((entry) => !entry.directory);
      let declaredAggregate = 0;
      for (const entry of declaredEntries) {
        declaredAggregate += entry.uncompressedSize;
        if (entry.compressedSize === 0 ? entry.uncompressedSize !== 0 : entry.uncompressedSize > entry.compressedSize * limits.expansionRatio) {
          fail(ctx, "ANALYZE_ARCHIVE_COMPRESSION_RATIO_EXCEEDED", "A ZIP entry exceeds the fixed 100:1 expansion ratio.", entry.name);
        }
      }
      if (declaredAggregate > (limits.declaredAggregateBytes ?? limits.selectedAggregateBytes)) {
        fail(ctx, "ANALYZE_ARCHIVE_DECLARED_BYTE_LIMIT_EXCEEDED", "The ZIP exceeds the fixed 1 GiB declared-byte limit.");
      }
    } else {
      let declaredAggregate = 0;
      for (const entry of allSelected) {
        declaredAggregate += entry.uncompressedSize;
        if (
          entry.compressedSize > ARCHIVE_LIMITS.selectedEntryBytes ||
          entry.uncompressedSize > ARCHIVE_LIMITS.selectedEntryBytes ||
          (entry.compressedSize === 0
            ? entry.uncompressedSize !== 0
            : entry.uncompressedSize > entry.compressedSize * ARCHIVE_LIMITS.expansionRatio)
        ) {
          fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", `Selected entry '${entry.name}' exceeds archive limits.`, entry.name);
        }
      }
      if (mutationAggregateBytesExceedsLimit(declaredAggregate)) {
        fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Selected entries exceed the 32 MiB aggregate limit.");
      }
    }

    const svgs: SelectedArchiveSvg[] = [];
    let actualAggregate = 0;
    await options.hooks?.beforeSelectedEntryInspection?.();
    for (const entry of selectedSvgEntries) {
      const bytes = await readEntry(handle, entry, stat.size, ctx, limits.selectedEntryBytes);
      actualAggregate += bytes.length;
      if (options.operation === "analyze" ? actualAggregate > limits.selectedAggregateBytes : mutationAggregateBytesExceedsLimit(actualAggregate)) {
        if (options.operation === "analyze") {
          fail(ctx, "ANALYZE_AGGREGATE_BYTE_LIMIT_EXCEEDED", "The input exceeds the fixed 512 MiB aggregate SVG limit.");
        }
        fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Inflated entries exceed the 32 MiB aggregate limit.");
      }
      const selected = {
        entryName: entry.name,
        bytes,
        compressedSize: entry.compressedSize,
        uncompressedSize: bytes.length,
      };
      await options.onSelectedSvg?.(selected);
      if (options.retainSelectedSvgs !== false) svgs.push(selected);
    }

    const companions: SelectedArchiveCompanion[] = [];
    const seenCompanionFilenames = new Map<string, string>();
    for (const entry of selectedCompanionEntries) {
      const bytes = await readEntry(handle, entry, stat.size, ctx, limits.selectedEntryBytes);
      actualAggregate += bytes.length;
      if (options.operation === "analyze" ? actualAggregate > limits.selectedAggregateBytes : mutationAggregateBytesExceedsLimit(actualAggregate)) {
        fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Inflated entries exceed the 32 MiB aggregate limit.");
      }
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        fail(ctx, "ARCHIVE_INVALID_UTF8", `Selected companion '${entry.name}' is not valid UTF-8.`, entry.name);
      }
      const filename = entry.name.split("/").pop() ?? entry.name;
      const previous = seenCompanionFilenames.get(filename);
      if (previous !== undefined) {
        fail(
          ctx,
          "ARCHIVE_COLLISION",
          `Companion entries '${previous}' and '${entry.name}' derive the same filename '${filename}'.`,
          entry.name,
        );
      }
      seenCompanionFilenames.set(filename, entry.name);
      companions.push({
        entryName: entry.name,
        filename,
        bytes,
        compressedSize: entry.compressedSize,
        uncompressedSize: bytes.length,
      });
    }

    const finalStat = await handle.stat();
    if (!sameSnapshot(snapshot, archiveSnapshot(archivePath, finalStat))) {
      fail(ctx, "ARCHIVE_CHANGED_DURING_PLAN", "Archive changed during candidate inspection.");
    }
    await verifyArchiveSnapshot(snapshot, options.operation ?? "import");
    return { svgs, companions, archiveDigest, snapshot, entryCount: entries.length, fileCount: entries.filter((entry) => !entry.directory).length };
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") {
      return fail(ctx, "ARCHIVE_READ_FAILED", "Archive could not be read safely.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readSvgArchive(
  archivePath: string,
  selections: readonly string[] = [],
): Promise<readonly SelectedArchiveSvg[]> {
  const result = await readArchive(archivePath, selections, []);
  return result.svgs;
}

export interface ManifestArchiveAssetEntry {
  readonly entryName: string;
  readonly assetId: AssetId;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface ManifestArchiveCompanionEntry {
  readonly entryName: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface ManifestArchiveReadResult {
  readonly manifest: AnyBundleManifest;
  readonly svgs: readonly ManifestArchiveAssetEntry[];
  readonly companions: readonly ManifestArchiveCompanionEntry[];
  readonly archiveDigest: Sha256Digest;
  readonly snapshot: ArchiveSnapshot;
}

export async function readManifestArchive(
  archivePath: string,
  svgSelections: readonly string[] = [],
  companionSelections: readonly string[] = [],
  options: ArchiveReadOptions = {},
): Promise<ManifestArchiveReadResult> {
  const ctx = archiveContext(archivePath, options.operation ?? "import");
  let handle: FileHandle | undefined;
  try {
    const pathStat = await lstat(archivePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      fail(ctx, "ARCHIVE_READ_FAILED", "Archive must be a non-symlink regular file.");
    }
    handle = await open(archivePath, "r");
    const stat = await handle.stat();
    const snapshot = archiveSnapshot(archivePath, stat);
    if (!sameSnapshot(snapshot, archiveSnapshot(archivePath, pathStat))) {
      fail(ctx, "ARCHIVE_CHANGED_DURING_PLAN", "Archive changed while it was opened.");
    }
    if (stat.size > ARCHIVE_LIMITS.archiveFileBytes) {
      fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Archive exceeds the fixed 128 MiB raw-file limit.");
    }
    const tailLength = Math.min(stat.size, 65_557);
    const tail = await readExactly(handle, tailLength, stat.size - tailLength, ctx);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) invalid(ctx, "ZIP end-of-central-directory record is missing.");
    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    const diskEntries = tail.readUInt16LE(eocd + 8);
    const totalEntries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    const commentLength = tail.readUInt16LE(eocd + 20);
    if (eocd + 22 + commentLength !== tail.length || disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      invalid(ctx, "Unsupported multi-disk or malformed ZIP archive.");
    }
    if (totalEntries > ARCHIVE_LIMITS.totalEntries) {
      fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Archive contains more than 1,024 entries.");
    }
    if (centralSize > ARCHIVE_LIMITS.centralDirectoryBytes || centralOffset + centralSize > stat.size) {
      fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "ZIP central directory exceeds the bounded importer limit.");
    }
    const entries = parseCentralDirectory(
      await readExactly(handle, centralSize, centralOffset, ctx),
      totalEntries,
      ctx,
    );

    await options.hooks?.afterStructure?.();
    const archiveDigest = await hashOpenArchive(handle, stat.size, ctx, options.hooks);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    // Find and parse manifest
    const manifestEntry = byName.get(BUNDLE_MANIFEST_FILENAME);
    if (manifestEntry === undefined) {
      fail(ctx, "ARCHIVE_MANIFEST_MISSING", "Archive lacks required root tfsb-manifest.json.");
    }
    for (const entry of entries) {
      if (entry.directory) {
        fail(ctx, "ARCHIVE_UNSAFE_TYPE", `Directory entry '${entry.name}' is not allowed in manifest-assisted archives.`, entry.name);
      }
    }

    const manifestBytes = await readEntry(handle, manifestEntry, stat.size, ctx);
    let manifestText: string;
    try {
      manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
    } catch {
      fail(ctx, "ARCHIVE_INVALID_UTF8", "Manifest JSON is not valid UTF-8.");
    }

    const manifest = unwrapBundleManifest(parseBundleManifest(manifestText, BUNDLE_MANIFEST_FILENAME));

    if (manifest.schemaVersion === 2) {
      if (byName.has("tfsb-brand-manifest.json")) {
        fail(
          ctx,
          "BRAND_MANIFEST_PRESENT",
          "Brand manifest 'tfsb-brand-manifest.json' is present in archive; run 'tfsb import <archive> --manifest --brand-package' to import brand package.",
        );
      }

      // Inventory check for v2: regular files in archive must equal manifest.files (by path) + manifest itself
      const manifestPaths = new Set(manifest.files.map((file) => file.path));
      for (const entry of entries) {
        if (entry.name !== BUNDLE_MANIFEST_FILENAME && !manifestPaths.has(entry.name)) {
          fail(ctx, "ARCHIVE_UNDECLARED_ENTRY", `Archive contains undeclared entry '${entry.name}'.`, entry.name);
        }
      }
      for (const file of manifest.files) {
        if (file.type !== "asset" && file.type !== "companion") {
          fail(
            ctx,
            "MANIFEST_UNSUPPORTED_RECORD",
            `Manifest entry '${file.path}' has unsupported record type '${(file as any).type}' for ordinary manifest import; brand domain files require --brand-package.`,
            file.path,
          );
        }
        if (!byName.has(file.path)) {
          fail(ctx, "ARCHIVE_MISSING_ENTRY", `Manifest lists entry '${file.path}' which is missing from archive.`, file.path);
        }
      }

      // Check size limits across declared entries
      let declaredAggregate = manifestBytes.length;
      for (const file of manifest.files) {
        const entry = byName.get(file.path)!;
        declaredAggregate += entry.uncompressedSize;
        if (
          entry.compressedSize > ARCHIVE_LIMITS.selectedEntryBytes ||
          entry.uncompressedSize > ARCHIVE_LIMITS.selectedEntryBytes ||
          (entry.compressedSize === 0
            ? entry.uncompressedSize !== 0
            : entry.uncompressedSize > entry.compressedSize * ARCHIVE_LIMITS.expansionRatio)
        ) {
          fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", `Selected entry '${entry.name}' exceeds archive limits.`, entry.name);
        }
      }
      if (mutationAggregateBytesExceedsLimit(declaredAggregate)) {
        fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Selected entries exceed the 32 MiB aggregate limit.");
      }

      // Read and verify digest for EVERY manifest entry
      const readEntriesByPath = new Map<string, { bytes: Uint8Array; entry: CentralEntry }>();
      await options.hooks?.beforeSelectedEntryInspection?.();

      for (const file of manifest.files) {
        const entry = byName.get(file.path)!;
        const bytes = await readEntry(handle, entry, stat.size, ctx);
        const computedSha256 = computeRawSha256(bytes);
        if (computedSha256 !== file.sha256) {
          fail(ctx, "ARCHIVE_DIGEST_MISMATCH", `Digest mismatch for entry '${file.path}'.`, file.path);
        }
        readEntriesByPath.set(file.path, { bytes, entry });
      }

      // Selection handling
      const isFiltered = svgSelections.length > 0 || companionSelections.length > 0;
      const selectedSvgPaths = new Set(svgSelections);
      const selectedCompanionPaths = new Set(companionSelections);

      if (isFiltered) {
        for (const sel of svgSelections) {
          const found = manifest.files.find((f) => f.type === "asset" && (f.path === sel || f.assetId === sel));
          if (found === undefined) {
            fail(ctx, "ARCHIVE_SELECTION_MISSING", `Selected entry '${sel}' does not exist in manifest.`, sel);
          }
        }
        for (const sel of companionSelections) {
          const found = manifest.files.find((f) => f.type === "companion" && f.path === sel);
          if (found === undefined) {
            fail(ctx, "ARCHIVE_SELECTION_MISSING", `Selected companion '${sel}' does not exist in manifest.`, sel);
          }
        }
      }

      const svgs: ManifestArchiveAssetEntry[] = [];
      const companions: ManifestArchiveCompanionEntry[] = [];

      for (const file of manifest.files) {
        if (file.type === "asset") {
          if (isFiltered && !selectedSvgPaths.has(file.path) && !selectedSvgPaths.has(file.assetId)) continue;
          const { bytes, entry } = readEntriesByPath.get(file.path)!;
          svgs.push({
            entryName: file.path,
            assetId: file.assetId,
            bytes,
            sha256: file.sha256,
            compressedSize: entry.compressedSize,
            uncompressedSize: bytes.length,
          });
        } else if (file.type === "companion") {
          if (isFiltered && !selectedCompanionPaths.has(file.path)) continue;
          const { bytes, entry } = readEntriesByPath.get(file.path)!;
          const leaf = file.path.split("/").pop() ?? file.path;
          companions.push({
            entryName: file.path,
            filename: leaf,
            bytes,
            sha256: file.sha256,
            compressedSize: entry.compressedSize,
            uncompressedSize: bytes.length,
          });
        }
      }

      if (svgs.length === 0 && options.allowNoSvgs !== true) {
        fail(ctx, "ARCHIVE_SELECTION_EMPTY", "Archive selection contains no SVG entries.");
      }
      if (mutationSvgCountExceedsLimit(svgs.length)) {
        fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Archive selects more than 128 SVG assets.");
      }

      const finalStat = await handle.stat();
      if (!sameSnapshot(snapshot, archiveSnapshot(archivePath, finalStat))) {
        fail(ctx, "ARCHIVE_CHANGED_DURING_PLAN", "Archive changed during candidate inspection.");
      }
      await verifyArchiveSnapshot(snapshot, options.operation ?? "import");

      return { manifest, svgs, companions, archiveDigest, snapshot };
    }

    // Schema 1 manifest
    const manifestNames = new Set(manifest.files.map((file) => file.name));
    for (const entry of entries) {
      if (entry.name !== BUNDLE_MANIFEST_FILENAME && !manifestNames.has(entry.name)) {
        fail(ctx, "ARCHIVE_UNDECLARED_ENTRY", `Archive contains undeclared entry '${entry.name}'.`, entry.name);
      }
    }
    for (const file of manifest.files) {
      if (!byName.has(file.name)) {
        fail(ctx, "ARCHIVE_MISSING_ENTRY", `Manifest lists entry '${file.name}' which is missing from archive.`, file.name);
      }
    }

    // Check size limits across declared entries
    let declaredAggregate = manifestBytes.length;
    for (const file of manifest.files) {
      const entry = byName.get(file.name)!;
      declaredAggregate += entry.uncompressedSize;
      if (
        entry.compressedSize > ARCHIVE_LIMITS.selectedEntryBytes ||
        entry.uncompressedSize > ARCHIVE_LIMITS.selectedEntryBytes ||
        (entry.compressedSize === 0
          ? entry.uncompressedSize !== 0
          : entry.uncompressedSize > entry.compressedSize * ARCHIVE_LIMITS.expansionRatio)
      ) {
        fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", `Selected entry '${entry.name}' exceeds archive limits.`, entry.name);
      }
    }
    if (mutationAggregateBytesExceedsLimit(declaredAggregate)) {
      fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Selected entries exceed the 32 MiB aggregate limit.");
    }

    // Read and verify digest for EVERY manifest entry
    const readEntriesByName = new Map<string, { bytes: Uint8Array; entry: CentralEntry }>();
    await options.hooks?.beforeSelectedEntryInspection?.();

    for (const file of manifest.files) {
      const entry = byName.get(file.name)!;
      const bytes = await readEntry(handle, entry, stat.size, ctx);
      const computedSha256 = computeRawSha256(bytes);
      if (computedSha256 !== file.sha256) {
        fail(ctx, "ARCHIVE_DIGEST_MISMATCH", `Digest mismatch for entry '${file.name}'.`, file.name);
      }
      readEntriesByName.set(file.name, { bytes, entry });
    }

    // Selection handling
    const isFiltered = svgSelections.length > 0 || companionSelections.length > 0;
    const selectedSvgNames = new Set(svgSelections);
    const selectedCompanionNames = new Set(companionSelections);

    if (isFiltered) {
      for (const sel of svgSelections) {
        const found = manifest.files.find((f) => f.type === "asset" && f.name === sel);
        if (found === undefined) {
          fail(ctx, "ARCHIVE_SELECTION_MISSING", `Selected entry '${sel}' does not exist in manifest.`, sel);
        }
      }
      for (const sel of companionSelections) {
        const found = manifest.files.find((f) => f.type === "companion" && f.name === sel);
        if (found === undefined) {
          fail(ctx, "ARCHIVE_SELECTION_MISSING", `Selected companion '${sel}' does not exist in manifest.`, sel);
        }
      }
    }

    const svgs: ManifestArchiveAssetEntry[] = [];
    const companions: ManifestArchiveCompanionEntry[] = [];

    for (const file of manifest.files) {
      if (file.type === "asset") {
        if (isFiltered && !selectedSvgNames.has(file.name)) continue;
        const { bytes, entry } = readEntriesByName.get(file.name)!;
        svgs.push({
          entryName: file.name,
          assetId: file.assetId,
          bytes,
          sha256: file.sha256,
          compressedSize: entry.compressedSize,
          uncompressedSize: bytes.length,
        });
      } else {
        if (isFiltered && !selectedCompanionNames.has(file.name)) continue;
        const { bytes, entry } = readEntriesByName.get(file.name)!;
        companions.push({
          entryName: file.name,
          filename: file.name,
          bytes,
          sha256: file.sha256,
          compressedSize: entry.compressedSize,
          uncompressedSize: bytes.length,
        });
      }
    }

    if (svgs.length === 0 && options.allowNoSvgs !== true) {
      fail(ctx, "ARCHIVE_SELECTION_EMPTY", "Archive selection contains no SVG entries.");
    }
    if (mutationSvgCountExceedsLimit(svgs.length)) {
      fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Archive selects more than 128 SVG assets.");
    }

    const finalStat = await handle.stat();
    if (!sameSnapshot(snapshot, archiveSnapshot(archivePath, finalStat))) {
      fail(ctx, "ARCHIVE_CHANGED_DURING_PLAN", "Archive changed during candidate inspection.");
    }
    await verifyArchiveSnapshot(snapshot, options.operation ?? "import");

    return { manifest, svgs, companions, archiveDigest, snapshot };
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") {
      return fail(ctx, "ARCHIVE_READ_FAILED", "Archive could not be read safely.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
