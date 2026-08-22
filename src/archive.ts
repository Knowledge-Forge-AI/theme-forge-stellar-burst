import { open, type FileHandle } from "node:fs/promises";

import { inflateSync } from "fflate";

import { DiagnosticError, fail, type DiagnosticContext } from "./diagnostics.js";

export const ARCHIVE_LIMITS = {
  totalEntries: 1_024,
  selectedSvgEntries: 128,
  selectedEntryBytes: 8 * 1024 * 1024,
  selectedAggregateBytes: 32 * 1024 * 1024,
  expansionRatio: 100,
  centralDirectoryBytes: 64 * 1024 * 1024,
} as const;

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

function archiveContext(source: string): DiagnosticContext {
  return { operation: "import", domain: "archive", source };
}

function invalid(ctx: DiagnosticContext, message: string, location?: string): never {
  fail(ctx, "ARCHIVE_INVALID_ZIP", message, location);
}

async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
  ctx: DiagnosticContext,
): Promise<Buffer> {
  if (!Number.isInteger(length) || length < 0 || length > ARCHIVE_LIMITS.centralDirectoryBytes) {
    invalid(ctx, "ZIP structure size is invalid.");
  }
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) invalid(ctx, "ZIP structure is truncated.");
  return buffer;
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
): Promise<Uint8Array> {
  if (entry.compressedSize > ARCHIVE_LIMITS.selectedEntryBytes) {
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
        out: new Uint8Array(Math.min(entry.uncompressedSize + 1, ARCHIVE_LIMITS.selectedEntryBytes + 1)),
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
    inflated.length > ARCHIVE_LIMITS.selectedEntryBytes
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
}

export async function readArchive(
  archivePath: string,
  svgSelections: readonly string[] = [],
  companionSelections: readonly string[] = [],
): Promise<ArchiveReadResult> {
  const ctx = archiveContext(archivePath);
  let handle: FileHandle | undefined;
  try {
    handle = await open(archivePath, "r");
    const stat = await handle.stat();
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
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const selectedSvgEntries =
      svgSelections.length === 0
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
    if (selectedSvgEntries.length === 0) fail(ctx, "ARCHIVE_SELECTION_EMPTY", "Archive selection contains no SVG entries.");
    if (selectedSvgEntries.length > ARCHIVE_LIMITS.selectedSvgEntries) {
      fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Archive selects more than 128 SVG entries.");
    }

    const uniqueCompanionSelections = [...new Set(companionSelections)];
    const selectedCompanionEntries = uniqueCompanionSelections.map((selection) => {
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
    if (declaredAggregate > ARCHIVE_LIMITS.selectedAggregateBytes) {
      fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Selected entries exceed the 32 MiB aggregate limit.");
    }

    const svgs: SelectedArchiveSvg[] = [];
    let actualAggregate = 0;
    for (const entry of selectedSvgEntries) {
      const bytes = await readEntry(handle, entry, stat.size, ctx);
      actualAggregate += bytes.length;
      if (actualAggregate > ARCHIVE_LIMITS.selectedAggregateBytes) {
        fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", "Inflated entries exceed the 32 MiB aggregate limit.");
      }
      svgs.push({
        entryName: entry.name,
        bytes,
        compressedSize: entry.compressedSize,
        uncompressedSize: bytes.length,
      });
    }

    const companions: SelectedArchiveCompanion[] = [];
    const seenCompanionFilenames = new Map<string, string>();
    for (const entry of selectedCompanionEntries) {
      const bytes = await readEntry(handle, entry, stat.size, ctx);
      actualAggregate += bytes.length;
      if (actualAggregate > ARCHIVE_LIMITS.selectedAggregateBytes) {
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

    return { svgs, companions };
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
