import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { inflateSync } from "fflate";

import { hashOpenArchive, isAllowedCompanionFilename, type ArchiveSnapshot } from "../archive.js";
import {
  ASSET_DIGEST_BASIS_V2,
  computeAssetSemanticDigest,
  computeCompanionByteDigest,
  computeRawSha256,
  computeSha256,
  computeSvgOutputDigest,
  type Sha256Digest,
} from "../digests.js";
import { DiagnosticError, fail, type DiagnosticContext } from "../diagnostics.js";
import { readExactBuffer, readOpenedFile, readRegularFileSnapshot, sameFileIdentity, identity, type FileIdentity } from "../filesystem.js";
import {
  BUNDLE_MANIFEST_FILENAME,
  parseBundleManifestV2,
  type BundleManifestRecordV2,
  type BundleManifestV2,
} from "../manifest.js";
import { enforceMutationAssetLimit, type LoadedProject } from "../project.js";
import { compareUtf8 } from "../provenance.js";
import {
  ARCHIVE_DIGEST_BASIS,
  ARCHIVE_SOURCE_DIGEST_BASIS,
  COMPANION_DIGEST_BASIS,
  parseImportProvenanceV2,
  serializeImportProvenanceV2,
  type ImportProvenanceV2,
} from "../provenance2.js";
import { defaultProjectName, resolveImportRoot } from "../root.js";
import { parseSvgV2, serializeSvgV2 } from "../schema2-svg.js";
import { parseAssetTomlV2, parseProjectTomlV2, serializeAssetTomlV2, serializeProjectTomlV2 } from "../schema2-toml.js";
import type { NormalizedAssetV2, NormalizedProjectV2 } from "../schema2-types.js";
import {
  executeCanonicalTransaction,
  snapshotCanonicalTree,
  type CanonicalSnapshot,
  type TransactionHooks,
} from "../transaction.js";
import type { AssetId, ProjectRelativePath, SvgFilename } from "../types.js";
import { TOOL_VERSION } from "../version.js";
import {
  BRAND_BUNDLE_MANIFEST_FILENAME,
  computeBrandBundleManifestDigest,
  parseBrandBundleManifest,
  type BrandBundleManifest,
  type BrandBundleManifestCompanion,
  type BrandBundleManifestInventoryItem,
} from "./brand-bundle-manifest.js";
import { validateBrandSemantics } from "./brand-core.js";
import { computeBrandDigest, computeBrandSystemDigest, encodeCanonicalJson } from "./brand-digests.js";
import { BRAND_FILE_INVENTORY } from "./brand-files.js";
import { createBrandDiffSnapshot, type BrandDiffSnapshot } from "./brand-diff.js";
import { parseBrandDerivedReceipt, type BrandDerivedReceipt } from "./derived-receipt.js";
import { inspectDerivedAuthority } from "./derive.js";
import {
  computeBrandPackageDigest,
  parseBrandPackageToml,
  type BrandPackageCompanion,
  type BrandPackageModel,
} from "./brand-package.js";
import {
  computeBrandRecipesDigest,
  parseBrandRecipesToml,
  toBrandRecipesCanonicalDto,
  type BrandRecipesModel,
} from "./recipes.js";
import { parseBrandToml, type BrandModel } from "./brand-schema.js";
import {
  computeBrandTokensDigest,
  parseBrandTokensToml,
  toBrandTokensCanonicalDto,
  type BrandTokensModel,
} from "./tokens.js";
import { computeBrandQaDigest, parseBrandQaToml, toBrandQaCanonicalDto, type BrandQaModel } from "./qa-schema.js";
import { computeConsumerProfileDigest, computeConsumerProfilesDomainDigest, parseConsumerProfilesToml, type ConsumerProfilesModel } from "./consumer-profile.js";
import { computeBrandExportsDomainDigest, computeRawBrandExportsFileDigest, parseBrandExportsToml, validateBrandExportSemantics, type BrandExportsModel } from "./export-profile.js";

export const BRAND_IMPORT_LIMITS = {
  totalEntries: 514,
  selectedEntryBytes: 8 * 1024 * 1024,
  baselineEntryBytes: 32 * 1024 * 1024,
  selectedAggregateBytes: 288 * 1024 * 1024,
  centralDirectoryBytes: 64 * 1024 * 1024,
  archiveFileBytes: 384 * 1024 * 1024,
  expansionRatio: 100,
} as const;

export interface BrandImportOptions {
  readonly archive: string;
  readonly root?: string;
  readonly dryRun?: boolean;
}

export interface BrandImportFileSummary {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface BrandImportCompanionSummary {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly digest: Sha256Digest;
}

const brandImportPlanBrand: unique symbol = Symbol("tfsb-brand-import-plan");

export interface BrandImportPlan {
  readonly root: string;
  readonly archive: string;
  readonly archiveDigest: Sha256Digest;
  readonly project: NormalizedProjectV2;
  readonly brandModel: BrandModel;
  readonly packageModel: BrandPackageModel;
  readonly brandManifest: BrandBundleManifest;
  readonly consumerProfilesModel?: ConsumerProfilesModel;
  readonly exportsModel?: BrandExportsModel;
  readonly assets: readonly NormalizedAssetV2[];
  readonly companions: readonly BrandImportCompanionSummary[];
  readonly files: readonly BrandImportFileSummary[];
  readonly [brandImportPlanBrand]: true;
}

interface BrandImportTransactionInternals {
  readonly canonicalSnapshot: CanonicalSnapshot;
  readonly archiveSnapshot: ArchiveSnapshot;
  readonly nextFiles: ReadonlyMap<string, Uint8Array>;
  readonly brandModel: BrandModel;
  readonly packageModel: BrandPackageModel;
  readonly brandManifest: BrandBundleManifest;
  readonly expectedAssets: readonly NormalizedAssetV2[];
  readonly expectedCompanions: readonly {
    readonly id: string;
    readonly filename: string;
    readonly bytes: Uint8Array;
    readonly digest: Sha256Digest;
  }[];
  readonly archiveHandle: FileHandle;
  readonly diffSnapshot: BrandDiffSnapshot;
  readonly canonicalSvgBytes: ReadonlyMap<string, Uint8Array>;
  disposed: boolean;
}

const brandImportInternals = new WeakMap<BrandImportPlan, BrandImportTransactionInternals>();

export async function disposeBrandImportPlan(plan: BrandImportPlan): Promise<void> {
  const internals = brandImportInternals.get(plan);
  if (internals === undefined || internals.disposed) return;
  internals.disposed = true;
  if (internals.archiveHandle !== undefined) {
    await internals.archiveHandle.close().catch(() => undefined);
  }
}

function deepCloneAndFreezePlain<T>(val: T): T {
  if (val === null || typeof val !== "object") {
    return val;
  }
  if (Array.isArray(val)) {
    const copy = val.map((item) => deepCloneAndFreezePlain(item));
    return Object.freeze(copy) as unknown as T;
  }
  const copy: any = {};
  for (const key of Reflect.ownKeys(val)) {
    copy[key] = deepCloneAndFreezePlain((val as any)[key]);
  }
  return Object.freeze(copy) as T;
}

function context(source?: string): DiagnosticContext {
  return { operation: "import", domain: "project", ...(source === undefined ? {} : { source }) };
}

function archiveContext(source: string): DiagnosticContext {
  return { operation: "import", domain: "archive", source };
}

function fileIdentity(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

interface CentralEntry {
  readonly name: string;
  readonly directory: boolean;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
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

function decodeEntryName(bytes: Uint8Array, utf8Flag: boolean, ctx: DiagnosticContext): string {
  if (!utf8Flag && bytes.some((byte) => byte > 0x7f)) {
    fail(ctx, "ARCHIVE_INVALID_ZIP", "Non-ASCII ZIP entry names must carry the UTF-8 flag.");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(ctx, "ARCHIVE_INVALID_ZIP", "ZIP entry name is not valid UTF-8.");
  }
  if (decoded !== decoded.normalize("NFC")) {
    fail(ctx, "ARCHIVE_INVALID_ZIP", `ZIP entry name '${decoded}' is not in canonical NFC form.`, decoded);
  }
  return decoded;
}

async function readZipEntry(
  handle: FileHandle,
  entry: CentralEntry,
  fileSize: number,
  ctx: DiagnosticContext,
  maxBytes = BRAND_IMPORT_LIMITS.selectedEntryBytes,
): Promise<Uint8Array> {
  if (entry.compressedSize > maxBytes) {
    fail(ctx, "ARCHIVE_LIMIT_EXCEEDED", `Selected entry '${entry.name}' exceeds archive limits.`, entry.name);
  }
  if (entry.localHeaderOffset + 30 > fileSize) {
    fail(ctx, "ARCHIVE_INVALID_ZIP", "ZIP local-file header offset exceeds archive bounds.", entry.name);
  }
  const header = await readExactBuffer(handle, 30, entry.localHeaderOffset, ctx, 30);
  if (header.readUInt32LE(0) !== 0x04034b50) {
    fail(ctx, "ARCHIVE_INVALID_ZIP", "Invalid ZIP local-file header.", entry.name);
  }
  const localFlags = header.readUInt16LE(6);
  const localMethod = header.readUInt16LE(8);
  if (localFlags !== entry.flags || localMethod !== entry.method) {
    fail(ctx, "ARCHIVE_INVALID_ZIP", "ZIP local and central metadata disagree.", entry.name);
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  if (entry.localHeaderOffset + 30 + nameLength > fileSize) {
    fail(ctx, "ARCHIVE_INVALID_ZIP", "ZIP local name exceeds archive bounds.", entry.name);
  }
  const localNameBuffer = await readExactBuffer(handle, nameLength, entry.localHeaderOffset + 30, ctx, 65535);
  const localName = decodeEntryName(localNameBuffer, (localFlags & 0x0800) !== 0, ctx);
  if (localName !== entry.name) {
    fail(
      ctx,
      "ARCHIVE_INVALID_ZIP",
      `ZIP local header name '${localName}' does not match central directory name '${entry.name}'.`,
      entry.name,
    );
  }

  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > fileSize) {
    fail(ctx, "ARCHIVE_INVALID_ZIP", "ZIP entry data offset exceeds archive bounds.", entry.name);
  }
  const compressed = await readExactBuffer(handle, entry.compressedSize, dataOffset, ctx, maxBytes);
  let inflated: Uint8Array;
  try {
    if (entry.method === 0) {
      inflated = compressed;
    } else if (entry.method === 8) {
      inflated = inflateSync(compressed, {
        out: new Uint8Array(Math.min(entry.uncompressedSize + 1, maxBytes + 1)),
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
    fail(ctx, "ARCHIVE_INVALID_ZIP", `Selected entry '${entry.name}' cannot be decompressed.`, entry.name);
  }
  if (inflated.length !== entry.uncompressedSize || inflated.length > maxBytes) {
    fail(
      ctx,
      "ARCHIVE_LIMIT_EXCEEDED",
      `Selected entry '${entry.name}' exceeds or disagrees with its declared size.`,
      entry.name,
    );
  }
  if (crc32(inflated) !== entry.crc32) {
    fail(ctx, "ARCHIVE_INVALID_ZIP", `CRC mismatch for '${entry.name}'.`, entry.name);
  }
  return inflated;
}

async function inspectBrandImportCandidate(options: BrandImportOptions, inspectionOnly: boolean): Promise<BrandImportPlan> {
  const root = inspectionOnly ? await realpath(options.root ?? process.cwd()) : await resolveImportRoot(options.root);
  const ctx = context(options.archive);
  const archCtx = archiveContext(options.archive);

  // Mutation planning requires an absent target. Read-only archive comparison
  // reuses the same verifier against an initialized project without staging it.
  const targetStat = await lstat(join(root, ".tfsb")).catch(() => undefined);
  if (!inspectionOnly && targetStat !== undefined) fail(ctx, "ROOT_ALREADY_INITIALIZED", "Import refuses an existing .tfsb directory.", ".tfsb");

  const canonicalSnapshot = await snapshotCanonicalTree(root, true, "import");
  if (!inspectionOnly && canonicalSnapshot.canonicalPresent) {
    fail(ctx, "ROOT_ALREADY_INITIALIZED", "Import refuses an existing .tfsb directory.", ".tfsb");
  }

  // Open and validate archive file
  const archivePath = resolve(options.archive);
  const pathStat = await lstat(archivePath).catch(() => undefined);
  if (pathStat === undefined || !pathStat.isFile() || pathStat.isSymbolicLink()) {
    fail(archCtx, "ARCHIVE_READ_FAILED", "Archive must be a non-symlink regular file.");
  }
  if (pathStat.size > BRAND_IMPORT_LIMITS.archiveFileBytes) {
    fail(archCtx, "ARCHIVE_LIMIT_EXCEEDED", "Archive exceeds the fixed 384 MiB raw-file limit.");
  }

  const handle = await open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!sameFileIdentity(fileIdentity(pathStat), fileIdentity(stat))) {
      fail(archCtx, "ARCHIVE_READ_FAILED", "Archive changed or was substituted during open.");
    }

    const tailLength = Math.min(stat.size, 65_557);
    const tail = await readExactBuffer(handle, tailLength, stat.size - tailLength, archCtx, 65557);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) fail(archCtx, "ARCHIVE_INVALID_ZIP", "ZIP end-of-central-directory record is missing.");
    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    const diskEntries = tail.readUInt16LE(eocd + 8);
    const totalEntries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    const commentLength = tail.readUInt16LE(eocd + 20);

    if (
      disk === 0xffff ||
      centralDisk === 0xffff ||
      diskEntries === 0xffff ||
      totalEntries === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      fail(archCtx, "ARCHIVE_INVALID_ZIP", "ZIP64 archives are not supported.");
    }

    if (eocd + 22 + commentLength !== tail.length || disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      fail(archCtx, "ARCHIVE_INVALID_ZIP", "Unsupported multi-disk or malformed ZIP archive.");
    }
    if (totalEntries > BRAND_IMPORT_LIMITS.totalEntries) {
      fail(archCtx, "ARCHIVE_LIMIT_EXCEEDED", `Archive contains ${totalEntries} entries, exceeding limit ${BRAND_IMPORT_LIMITS.totalEntries}.`);
    }
    if (centralSize > BRAND_IMPORT_LIMITS.centralDirectoryBytes || centralOffset + centralSize > stat.size) {
      fail(archCtx, "ARCHIVE_LIMIT_EXCEEDED", "ZIP central directory exceeds limit.");
    }

    // Step 1: Parse Central Directory & verify limits
    const centralBuffer = await readExactBuffer(handle, centralSize, centralOffset, archCtx, BRAND_IMPORT_LIMITS.centralDirectoryBytes);
    const entries: CentralEntry[] = [];
    const entriesByName = new Map<string, CentralEntry>();
    let cdOffset = 0;
    let declaredAggregateUncompressedBytes = 0;

    for (let i = 0; i < totalEntries; i++) {
      if (cdOffset + 46 > centralBuffer.length || centralBuffer.readUInt32LE(cdOffset) !== 0x02014b50) {
        fail(archCtx, "ARCHIVE_INVALID_ZIP", "Invalid ZIP central-directory record.");
      }
      const madeBy = centralBuffer.readUInt16LE(cdOffset + 4);
      const madeByOs = madeBy >>> 8;
      const flags = centralBuffer.readUInt16LE(cdOffset + 8);
      const method = centralBuffer.readUInt16LE(cdOffset + 10);
      const crc = centralBuffer.readUInt32LE(cdOffset + 16);
      const compressedSize = centralBuffer.readUInt32LE(cdOffset + 20);
      const uncompressedSize = centralBuffer.readUInt32LE(cdOffset + 24);
      const nameLength = centralBuffer.readUInt16LE(cdOffset + 28);
      const extraLength = centralBuffer.readUInt16LE(cdOffset + 30);
      const commentLen = centralBuffer.readUInt16LE(cdOffset + 32);
      const diskNo = centralBuffer.readUInt16LE(cdOffset + 34);
      const extAttrs = centralBuffer.readUInt32LE(cdOffset + 38);
      const localOffset = centralBuffer.readUInt32LE(cdOffset + 42);
      const nextOffset = cdOffset + 46 + nameLength + extraLength + commentLen;
      if (nextOffset > centralBuffer.length || diskNo !== 0) {
        fail(archCtx, "ARCHIVE_INVALID_ZIP", "Malformed central directory.");
      }

      const rawName = decodeEntryName(
        centralBuffer.subarray(cdOffset + 46, cdOffset + 46 + nameLength),
        (flags & 0x0800) !== 0,
        archCtx,
      );

      if ((flags & 0x0001) !== 0) {
        fail(archCtx, "ARCHIVE_ENCRYPTED", `Encrypted entry '${rawName}' is not allowed.`, rawName);
      }

      // Check for directory entry, symlink, or special Unix types (FIFO, socket, block/char device)
      const unixMode = extAttrs >>> 16;
      const unixType = unixMode & 0o170000;
      const directoryByName = rawName.endsWith("/");
      const directoryByDos = (extAttrs & 0x10) !== 0;
      const directory = directoryByName || directoryByDos || unixType === 0o040000;

      if (directory) {
        fail(archCtx, "ARCHIVE_UNSAFE_TYPE", `Directory entry '${rawName}' is not allowed in brand bundles.`, rawName);
      }
      if (unixType === 0o120000) {
        fail(archCtx, "ARCHIVE_UNSAFE_TYPE", `Symlink entry '${rawName}' is not allowed.`, rawName);
      }
      if (madeByOs === 3 && unixType !== 0 && unixType !== 0o100000) {
        fail(archCtx, "ARCHIVE_UNSAFE_TYPE", `Non-regular entry '${rawName}' is not allowed.`, rawName);
      }
      if (directoryByName || directoryByDos) {
        fail(archCtx, "ARCHIVE_UNSAFE_TYPE", `Entry type for '${rawName}' is ambiguous.`, rawName);
      }

      if (
        rawName === "" ||
        rawName.includes("\\") ||
        rawName.includes("\0") ||
        rawName.startsWith("/") ||
        /^[A-Za-z]:/.test(rawName) ||
        rawName.startsWith("//") ||
        /[\x00-\x1F\x7F]/.test(rawName)
      ) {
        fail(archCtx, "ARCHIVE_UNSAFE_PATH", `Unsafe archive entry path '${rawName}'.`, rawName);
      }
      const segments = rawName.split("/");
      if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        fail(archCtx, "ARCHIVE_UNSAFE_PATH", `Unsafe archive entry path '${rawName}'.`, rawName);
      }

      // Enforce 100:1 ratio per entry
      const entryLimit = rawName.startsWith("baselines/") ? BRAND_IMPORT_LIMITS.baselineEntryBytes : BRAND_IMPORT_LIMITS.selectedEntryBytes;
      if (
        compressedSize > entryLimit ||
        uncompressedSize > entryLimit ||
        (compressedSize === 0
          ? uncompressedSize !== 0
          : uncompressedSize > compressedSize * BRAND_IMPORT_LIMITS.expansionRatio)
      ) {
        fail(archCtx, "ARCHIVE_LIMIT_EXCEEDED", `Selected entry '${rawName}' exceeds archive limits.`, rawName);
      }

      declaredAggregateUncompressedBytes += uncompressedSize;
      if (declaredAggregateUncompressedBytes > BRAND_IMPORT_LIMITS.selectedAggregateBytes) {
        fail(archCtx, "ARCHIVE_LIMIT_EXCEEDED", "Declared uncompressed bytes exceed the brand-bundle aggregate limit.");
      }

      const entry: CentralEntry = {
        name: rawName,
        directory: false,
        flags,
        method,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset: localOffset,
      };

      if (entriesByName.has(rawName)) {
        fail(archCtx, "ARCHIVE_COLLISION", `Duplicate entry '${rawName}' in ZIP.`, rawName);
      }
      entriesByName.set(rawName, entry);
      entries.push(entry);
      cdOffset = nextOffset;
    }

    if (cdOffset !== centralBuffer.length) {
      fail(archCtx, "ARCHIVE_INVALID_ZIP", "ZIP central directory has trailing unparsed bytes.");
    }

    // Stream hash the open archive
    const archiveDigest = await hashOpenArchive(handle, stat.size, archCtx);

    // Step 2 & 3: Locate and parse generic manifest v2 and reserved brand manifest
    const genericManifestEntry = entriesByName.get(BUNDLE_MANIFEST_FILENAME);
    if (genericManifestEntry === undefined) {
      fail(archCtx, "ARCHIVE_MANIFEST_MISSING", "Archive lacks required root tfsb-manifest.json.");
    }
    const brandManifestEntry = entriesByName.get(BRAND_BUNDLE_MANIFEST_FILENAME);
    if (brandManifestEntry === undefined) {
      fail(archCtx, "BRAND_MANIFEST_MISSING", "Archive lacks required root tfsb-brand-manifest.json.");
    }

    // Check for any other root json files
    for (const entry of entries) {
      if (!entry.name.includes("/") && entry.name.endsWith(".json")) {
        if (entry.name !== BUNDLE_MANIFEST_FILENAME && entry.name !== BRAND_BUNDLE_MANIFEST_FILENAME) {
          fail(archCtx, "ARCHIVE_UNDECLARED_ENTRY", `Unexpected root JSON file '${entry.name}'.`, entry.name);
        }
      }
    }

    const rawGenericManifestBytes = await readZipEntry(handle, genericManifestEntry, stat.size, archCtx);
    let genericManifestText: string;
    try {
      genericManifestText = new TextDecoder("utf-8", { fatal: true }).decode(rawGenericManifestBytes);
    } catch {
      fail(archCtx, "ARCHIVE_INVALID_UTF8", "Manifest JSON is not valid UTF-8.");
    }

    const genericManifestResult = parseBundleManifestV2(genericManifestText, BUNDLE_MANIFEST_FILENAME);
    if (!genericManifestResult.ok) {
      const diag = genericManifestResult.diagnostics[0];
      if (diag !== undefined) throw new DiagnosticError(diag);
      fail(archCtx, "MANIFEST_INVALID_JSON", "Failed to parse generic manifest.");
    }
    const genericManifest = genericManifestResult.value;

    // Check that neither reserved manifest is in genericManifest.files
    for (const f of genericManifest.files) {
      if (f.path === BUNDLE_MANIFEST_FILENAME || f.path === BRAND_BUNDLE_MANIFEST_FILENAME) {
        fail(archCtx, "MANIFEST_COLLISION", `Reserved manifest '${f.path}' cannot be listed in payload files.`, f.path);
      }
    }

    // Step 4: Verify payload paths, limits, and hashes
    const manifestPaths = new Set(genericManifest.files.map((f) => f.path));
    for (const entry of entries) {
      if (entry.name !== BUNDLE_MANIFEST_FILENAME && entry.name !== BRAND_BUNDLE_MANIFEST_FILENAME) {
        if (!manifestPaths.has(entry.name)) {
          fail(archCtx, "ARCHIVE_UNDECLARED_ENTRY", `Archive contains undeclared entry '${entry.name}'.`, entry.name);
        }
      }
    }
    for (const file of genericManifest.files) {
      if (!entriesByName.has(file.path)) {
        fail(archCtx, "ARCHIVE_MISSING_ENTRY", `Manifest lists entry '${file.path}' which is missing from archive.`, file.path);
      }
      if (file.path.startsWith("baselines/")) {
        if (file.type !== "file" || !/^baselines\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.png$/.test(file.path)) fail(archCtx, "ARCHIVE_UNSAFE_PATH", `QA baseline path '${file.path}' is invalid.`, file.path);
      }
      if (file.path.startsWith("derived/") && (file.type !== "file" || !/^derived\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.receipt\.json$/.test(file.path))) {
        fail(archCtx, "ARCHIVE_UNSAFE_PATH", `Derived receipt path '${file.path}' is invalid.`, file.path);
      }
    }

    // Read and verify all payload bytes
    let aggregatePayloadBytes = 0;
    const payloadBytesByPath = new Map<string, Uint8Array>();

    for (const file of genericManifest.files) {
      const entry = entriesByName.get(file.path)!;
      const bytes = await readZipEntry(handle, entry, stat.size, archCtx, file.path.startsWith("baselines/") ? BRAND_IMPORT_LIMITS.baselineEntryBytes : BRAND_IMPORT_LIMITS.selectedEntryBytes);
      aggregatePayloadBytes += bytes.length;
      if (aggregatePayloadBytes > BRAND_IMPORT_LIMITS.selectedAggregateBytes) {
        fail(archCtx, "ARCHIVE_LIMIT_EXCEEDED", "Payload bytes exceed the brand-bundle aggregate limit.");
      }

      const computedHex = computeRawSha256(bytes);
      if (computedHex !== file.sha256) {
        fail(archCtx, "ARCHIVE_DIGEST_MISMATCH", `Digest mismatch for entry '${file.path}'.`, file.path);
      }
      payloadBytesByPath.set(file.path, bytes);
    }

    // Step 5: Read and parse brand bundle manifest
    const rawBrandManifestBytes = await readZipEntry(handle, brandManifestEntry, stat.size, archCtx);
    let brandManifestText: string;
    try {
      brandManifestText = new TextDecoder("utf-8", { fatal: true }).decode(rawBrandManifestBytes);
    } catch {
      fail(archCtx, "ARCHIVE_INVALID_UTF8", "Brand manifest JSON is not valid UTF-8.");
    }

    const brandManifestResult = parseBrandBundleManifest(brandManifestText, BRAND_BUNDLE_MANIFEST_FILENAME);
    if (!brandManifestResult.ok) {
      const diag = brandManifestResult.diagnostics[0];
      if (diag !== undefined) throw new DiagnosticError(diag);
      fail(archCtx, "MANIFEST_INVALID_JSON", "Failed to parse brand manifest.");
    }
    const brandManifest = brandManifestResult.value;

    // Step 6: Verify raw genericManifestByteDigest
    const expectedGenericManifestByteDigest: Sha256Digest = `sha256:${computeRawSha256(rawGenericManifestBytes)}`;
    if (expectedGenericManifestByteDigest !== brandManifest.genericManifestByteDigest) {
      fail(
        archCtx,
        "MANIFEST_DIGEST_MISMATCH",
        `Generic manifest raw byte digest mismatch; expected '${expectedGenericManifestByteDigest}', got '${brandManifest.genericManifestByteDigest}'.`,
        BRAND_BUNDLE_MANIFEST_FILENAME,
      );
    }

    // Step 7: Brand manifest self-digest is verified inside parseBrandBundleManifest

    // Step 8: Brand package & brand TOML parsing & domain verification
    const brandPackageBytes = payloadBytesByPath.get("brand/brand-package.toml");
    if (brandPackageBytes === undefined) {
      fail(archCtx, "ARCHIVE_MISSING_ENTRY", "Archive lacks brand/brand-package.toml.");
    }
    let brandPackageText: string;
    try {
      brandPackageText = new TextDecoder("utf-8", { fatal: true }).decode(brandPackageBytes);
    } catch {
      fail(archCtx, "ARCHIVE_INVALID_UTF8", "brand-package.toml is not valid UTF-8.");
    }
    const packageModelResult = parseBrandPackageToml(brandPackageText, "brand/brand-package.toml");
    if (!packageModelResult.ok) {
      const diag = packageModelResult.diagnostics[0];
      if (diag !== undefined) throw new DiagnosticError(diag);
      fail(archCtx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-package.toml");
    }
    const packageModel = packageModelResult.value;

    const computedPkgDigest = computeBrandPackageDigest(packageModel);
    if (computedPkgDigest !== brandManifest.brandPackageDigest) {
      fail(
        archCtx,
        "BRAND_PACKAGE_DIGEST_MISMATCH",
        `Brand package digest mismatch; computed '${computedPkgDigest}', declared '${brandManifest.brandPackageDigest}'.`,
      );
    }
    if (packageModel.packageId !== brandManifest.packageId) {
      fail(archCtx, "BRAND_PACKAGE_MISMATCH", "Package ID mismatch between brand manifest and package TOML.");
    }
    if (packageModel.name !== brandManifest.name) {
      fail(archCtx, "BRAND_PACKAGE_MISMATCH", "Package name mismatch between brand manifest and package TOML.");
    }
    if (packageModel.brandVersion !== brandManifest.brandVersion) {
      fail(archCtx, "BRAND_PACKAGE_MISMATCH", "Brand version mismatch between brand manifest and package TOML.");
    }

    const brandTomlBytes = payloadBytesByPath.get("brand/brand.toml");
    if (brandTomlBytes === undefined) {
      fail(archCtx, "ARCHIVE_MISSING_ENTRY", "Archive lacks brand/brand.toml.");
    }
    let brandTomlText: string;
    try {
      brandTomlText = new TextDecoder("utf-8", { fatal: true }).decode(brandTomlBytes);
    } catch {
      fail(archCtx, "ARCHIVE_INVALID_UTF8", "brand.toml is not valid UTF-8.");
    }
    const brandModelResult = parseBrandToml(brandTomlText, "brand/brand.toml");
    if (!brandModelResult.ok) {
      const diag = brandModelResult.diagnostics[0];
      if (diag !== undefined) throw new DiagnosticError(diag);
      fail(archCtx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand.toml");
    }
    const brandModel = brandModelResult.value;

    const computedBrandDigest = computeBrandDigest(brandModel);
    if (computedBrandDigest !== brandManifest.domainDigests.brand) {
      fail(
        archCtx,
        "BRAND_DOMAIN_DIGEST_MISMATCH",
        `brand.toml domain digest mismatch; computed '${computedBrandDigest}', declared '${brandManifest.domainDigests.brand}'.`,
      );
    }

    let tokensModel: BrandTokensModel | undefined;
    const brandTokensBytes = payloadBytesByPath.get("brand/brand-tokens.toml");
    if (brandTokensBytes !== undefined) {
      let tokensText: string;
      try {
        tokensText = new TextDecoder("utf-8", { fatal: true }).decode(brandTokensBytes);
      } catch {
        fail(archCtx, "ARCHIVE_INVALID_UTF8", "brand-tokens.toml is not valid UTF-8.");
      }
      const tokResult = parseBrandTokensToml(tokensText, "brand/brand-tokens.toml");
      if (!tokResult.ok) {
        const diag = tokResult.diagnostics[0];
        if (diag !== undefined) throw new DiagnosticError(diag);
        fail(archCtx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-tokens.toml");
      }
      tokensModel = tokResult.value;
      const computedTokensDigest = computeBrandTokensDigest(tokensModel);
      if (brandManifest.domainDigests.tokens !== undefined && computedTokensDigest !== brandManifest.domainDigests.tokens) {
        fail(
          archCtx,
          "BRAND_DOMAIN_DIGEST_MISMATCH",
          `brand-tokens.toml domain digest mismatch; computed '${computedTokensDigest}', declared '${brandManifest.domainDigests.tokens}'.`,
        );
      }
    } else if (brandModel.enabledDomains.tokens) {
      fail(archCtx, "ARCHIVE_MISSING_ENTRY", "brand.toml declares tokens domain enabled but brand-tokens.toml is missing from bundle.");
    }

    let recipesModel: BrandRecipesModel | undefined;
    const brandRecipesBytes = payloadBytesByPath.get("brand/brand-recipes.toml");
    if (brandRecipesBytes !== undefined) {
      let recipesText: string;
      try {
        recipesText = new TextDecoder("utf-8", { fatal: true }).decode(brandRecipesBytes);
      } catch {
        fail(archCtx, "ARCHIVE_INVALID_UTF8", "brand-recipes.toml is not valid UTF-8.");
      }
      const recResult = parseBrandRecipesToml(recipesText, "brand/brand-recipes.toml");
      if (!recResult.ok) {
        const diag = recResult.diagnostics[0];
        if (diag !== undefined) throw new DiagnosticError(diag);
        fail(archCtx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-recipes.toml");
      }
      recipesModel = recResult.value;
      const computedRecipesDigest = computeBrandRecipesDigest(recipesModel);
      if (brandManifest.domainDigests.recipes !== undefined && computedRecipesDigest !== brandManifest.domainDigests.recipes) {
        fail(
          archCtx,
          "BRAND_DOMAIN_DIGEST_MISMATCH",
          `brand-recipes.toml domain digest mismatch; computed '${computedRecipesDigest}', declared '${brandManifest.domainDigests.recipes}'.`,
        );
      }
    } else if (brandModel.enabledDomains.recipes) {
      fail(archCtx, "ARCHIVE_MISSING_ENTRY", "brand.toml declares recipes domain enabled but brand-recipes.toml is missing from bundle.");
    }

    let qaModel: BrandQaModel | undefined;
    const brandQaBytes = payloadBytesByPath.get("brand/brand-qa.toml");
    if (brandQaBytes !== undefined) {
      let qaText: string;
      try { qaText = new TextDecoder("utf-8", { fatal: true }).decode(brandQaBytes); }
      catch { fail(archCtx, "ARCHIVE_INVALID_UTF8", "brand-qa.toml is not valid UTF-8."); }
      const qaResult = parseBrandQaToml(qaText, "brand/brand-qa.toml");
      if (!qaResult.ok) {
        const diagnostic = qaResult.diagnostics[0];
        if (diagnostic !== undefined) throw new DiagnosticError(diagnostic);
        fail(archCtx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-qa.toml");
      }
      qaModel = qaResult.value;
      const computedQaDigest = computeBrandQaDigest(qaModel);
      if (brandManifest.domainDigests.qa !== computedQaDigest) fail(archCtx, "BRAND_DOMAIN_DIGEST_MISMATCH", `brand-qa.toml domain digest mismatch; computed '${computedQaDigest}', declared '${brandManifest.domainDigests.qa ?? "absent"}'.`);
    } else if (brandModel.enabledDomains.qa) {
      fail(archCtx, "ARCHIVE_MISSING_ENTRY", "brand.toml declares QA domain enabled but brand-qa.toml is missing from bundle.");
    }

    let consumerProfilesModel: ConsumerProfilesModel | undefined;
    const consumerProfilesBytes = payloadBytesByPath.get("brand/consumer-profiles.toml");
    if (consumerProfilesBytes !== undefined) {
      let profilesText: string;
      try { profilesText = new TextDecoder("utf-8", { fatal: true }).decode(consumerProfilesBytes); }
      catch { fail(archCtx, "ARCHIVE_INVALID_UTF8", "consumer-profiles.toml is not valid UTF-8."); }
      const profileResult = parseConsumerProfilesToml(profilesText, "brand/consumer-profiles.toml");
      if (!profileResult.ok) { const diagnostic = profileResult.diagnostics[0]; if (diagnostic !== undefined) throw new DiagnosticError(diagnostic); fail(archCtx, "SCHEMA_INVALID_SYNTAX", "Failed to parse consumer-profiles.toml."); }
      consumerProfilesModel = profileResult.value;
      const domainDigest = computeConsumerProfilesDomainDigest(consumerProfilesModel);
      if (brandManifest.domainDigests.consumer_profiles !== domainDigest || packageModel.consumerProfileDigest !== domainDigest) fail(archCtx, "BRAND_DOMAIN_DIGEST_MISMATCH", "Consumer profile domain digest does not match package and manifest authority.");
      const ids = consumerProfilesModel.profiles.map((profile) => profile.id).sort(compareUtf8);
      if (ids.length !== packageModel.compatibleProfiles.length || ids.some((id, index) => id !== packageModel.compatibleProfiles[index])) fail(archCtx, "BRAND_PACKAGE_PROFILE_MISMATCH", "Package compatible profile inventory differs from profile domain.");
      const expectedRecords = consumerProfilesModel.profiles.map((profile) => ({ profileId: profile.qualifiedId, version: profile.version, digest: computeConsumerProfileDigest(profile) })).sort((a, b) => compareUtf8(a.profileId, b.profileId));
      if (encodeCanonicalJson(expectedRecords) !== encodeCanonicalJson(brandManifest.profiles)) fail(archCtx, "BRAND_MANIFEST_PROFILE_MISMATCH", "Brand manifest profile records differ from the profile domain.");
    } else if (brandModel.enabledDomains.consumerProfiles) {
      fail(archCtx, "ARCHIVE_MISSING_ENTRY", "brand.toml declares consumer profiles enabled but consumer-profiles.toml is missing from bundle.");
    } else if (brandManifest.profiles.length !== 0 || brandManifest.domainDigests.consumer_profiles !== undefined) {
      fail(archCtx, "BRAND_MANIFEST_PROFILE_MISMATCH", "Disabled consumer profile domain has manifest profile authority.");
    }

    let exportsModel: BrandExportsModel | undefined;
    const exportsBytes = payloadBytesByPath.get("brand/brand-exports.toml");
    if (exportsBytes !== undefined) {
      let exportsText: string;
      try { exportsText = new TextDecoder("utf-8", { fatal: true }).decode(exportsBytes); }
      catch { fail(archCtx, "ARCHIVE_INVALID_UTF8", "brand-exports.toml is not valid UTF-8."); }
      const exportsResult = parseBrandExportsToml(exportsText, "brand/brand-exports.toml");
      if (!exportsResult.ok) { const diagnostic = exportsResult.diagnostics[0]; if (diagnostic !== undefined) throw new DiagnosticError(diagnostic); fail(archCtx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-exports.toml."); }
      exportsModel = exportsResult.value;
      const domainDigest = computeBrandExportsDomainDigest(exportsModel);
      if (brandManifest.domainDigests.exports !== domainDigest || packageModel.exportProfileDigest !== domainDigest) fail(archCtx, "BRAND_DOMAIN_DIGEST_MISMATCH", "Export domain digest does not match package and manifest authority.");
    } else if (brandModel.enabledDomains.exports) {
      fail(archCtx, "ARCHIVE_MISSING_ENTRY", "brand.toml declares exports enabled but brand-exports.toml is missing from bundle.");
    } else if (brandManifest.domainDigests.exports !== undefined) {
      fail(archCtx, "BRAND_DOMAIN_DIGEST_MISMATCH", "Disabled export domain has manifest authority.");
    }

    // Step 9: Reconstruct canonical assets & verify SVG bytes
    const distinctAssetIds = [...new Set(brandManifest.inventory.map((item) => item.assetId))].sort(compareUtf8);
    const assetMap = new Map<string, NormalizedAssetV2>();
    const stagedFiles = new Map<string, Uint8Array>();
    const canonicalSvgBytes = new Map<string, Uint8Array>();

    for (const assetId of distinctAssetIds) {
      const invItems = brandManifest.inventory.filter((item) => item.assetId === assetId);
      const firstItem = invItems[0]!;

      // All inventory bindings referencing this asset must agree on bundlePath, canonicalAssetDigest, svgDigest
      for (const item of invItems) {
        if (
          item.bundlePath !== firstItem.bundlePath ||
          item.canonicalAssetDigest !== firstItem.canonicalAssetDigest ||
          item.svgDigest !== firstItem.svgDigest
        ) {
          fail(archCtx, "MANIFEST_COLLISION", `Inventory items for assetId '${assetId}' disagree on payload metadata.`);
        }
      }

      const svgPayloadBytes = payloadBytesByPath.get(firstItem.bundlePath);
      if (svgPayloadBytes === undefined) {
        fail(archCtx, "ARCHIVE_MISSING_ENTRY", `Inventory asset '${firstItem.bundlePath}' is missing from payload.`);
      }

      let svgText: string;
      try {
        svgText = new TextDecoder("utf-8", { fatal: true }).decode(svgPayloadBytes);
      } catch {
        fail(archCtx, "ARCHIVE_INVALID_UTF8", `SVG '${firstItem.bundlePath}' is not valid UTF-8.`);
      }

      const parsedSvg = parseSvgV2(svgText, firstItem.bundlePath);
      if (!parsedSvg.ok) {
        const diag = parsedSvg.diagnostics[0];
        if (diag !== undefined) throw new DiagnosticError(diag);
        fail(archCtx, "SVG_INVALID", `Failed to parse SVG '${firstItem.bundlePath}'.`);
      }

      const leafFilename = firstItem.bundlePath.slice("assets/".length) as SvgFilename;
      const asset: NormalizedAssetV2 = {
        schemaVersion: 2,
        id: assetId as AssetId,
        filename: leafFilename,
        svg: parsedSvg.value,
      };

      const computedCanonicalDigest = computeAssetSemanticDigest(asset);
      if (computedCanonicalDigest !== firstItem.canonicalAssetDigest) {
        fail(
          archCtx,
          "ASSET_DIGEST_MISMATCH",
          `Canonical asset digest mismatch for '${assetId}'; computed '${computedCanonicalDigest}', declared '${firstItem.canonicalAssetDigest}'.`,
        );
      }

      const reserializedSvg = serializeSvgV2(asset.svg, firstItem.bundlePath);
      if (!reserializedSvg.ok) {
        fail(archCtx, "SVG_INVALID", `Failed to serialize SVG for '${assetId}'.`);
      }
      if (reserializedSvg.value !== svgText) {
        fail(archCtx, "SVG_DIGEST_MISMATCH", `Rendered SVG for '${assetId}' did not match payload bytes.`);
      }

      const computedSvgDigest: Sha256Digest = `sha256:${computeRawSha256(svgPayloadBytes)}`;
      if (computedSvgDigest !== firstItem.svgDigest) {
        fail(
          archCtx,
          "SVG_DIGEST_MISMATCH",
          `SVG digest mismatch for '${assetId}'; computed '${computedSvgDigest}', declared '${firstItem.svgDigest}'.`,
        );
      }

      assetMap.set(assetId, asset);
      canonicalSvgBytes.set(assetId, new Uint8Array(svgPayloadBytes));

      // Stage canonical asset TOML
      const assetToml = serializeAssetTomlV2(asset);
      stagedFiles.set(`.tfsb/assets/${asset.id}.toml`, Buffer.from(assetToml, "utf8"));
    }

    const assets = [...assetMap.values()].sort((a, b) => compareUtf8(a.id, b.id));
    enforceMutationAssetLimit(assets.length, "import");

    // Step 10: Inventory 1:1 cross-checking
    if (packageModel.inventory.length !== brandModel.bindings.length) {
      fail(
        archCtx,
        "BRAND_PACKAGE_INCOMPLETE_INVENTORY",
        `Package inventory count ${packageModel.inventory.length} does not match brand.toml bindings count ${brandModel.bindings.length}.`,
      );
    }
    for (const binding of brandModel.bindings) {
      const foundInPkg = packageModel.inventory.find(
        (item) =>
          item.family === binding.family &&
          item.role === binding.role &&
          item.variant === binding.variant &&
          item.asset === binding.asset,
      );
      if (foundInPkg === undefined) {
        fail(
          archCtx,
          "BRAND_PACKAGE_INCOMPLETE_INVENTORY",
          `brand.toml binding '${binding.family}:${binding.role}:${binding.variant}' -> '${binding.asset}' is missing from brand-package.toml inventory.`,
        );
      }
    }

    if (brandManifest.inventory.length !== packageModel.inventory.length) {
      fail(
        archCtx,
        "BRAND_PACKAGE_MISMATCH",
        `Brand manifest inventory count ${brandManifest.inventory.length} does not match package inventory count ${packageModel.inventory.length}.`,
      );
    }
    for (const pkgItem of packageModel.inventory) {
      const foundInMani = brandManifest.inventory.find(
        (item) =>
          item.family === pkgItem.family &&
          item.role === pkgItem.role &&
          item.variant === pkgItem.variant &&
          item.assetId === pkgItem.asset,
      );
      if (foundInMani === undefined) {
        fail(
          archCtx,
          "BRAND_PACKAGE_MISMATCH",
          `Package inventory item '${pkgItem.family}:${pkgItem.role}:${pkgItem.variant}' -> '${pkgItem.asset}' is missing from brand manifest.`,
        );
      }
      if (
        foundInMani.canonicalAssetDigest !== pkgItem.canonicalAssetDigest ||
        foundInMani.svgDigest !== pkgItem.svgDigest
      ) {
        fail(
          archCtx,
          "BRAND_PACKAGE_MISMATCH",
          `Digest mismatch in brand manifest for inventory item '${pkgItem.family}:${pkgItem.role}:${pkgItem.variant}'.`,
        );
      }
    }

    // Step 11: Validate semantic completeness and compute brandSystemDigest
    const brandSemantics = validateBrandSemantics(brandModel, assetMap, ctx, recipesModel);
    if (exportsModel !== undefined) validateBrandExportSemantics(exportsModel, brandModel, tokensModel, assetMap, ctx);
    if (!brandSemantics.completeness.satisfied) {
      fail(archCtx, "BRAND_INCOMPLETE", "Brand system requirements are not fully satisfied.");
    }

    const computedBrandSystemDigest = computeBrandSystemDigest({
      brand: brandModel,
      tokens: tokensModel ? toBrandTokensCanonicalDto(tokensModel) : null,
      recipes: recipesModel ? toBrandRecipesCanonicalDto(recipesModel) : null,
      qa: qaModel === undefined ? null : toBrandQaCanonicalDto(qaModel),
      consumerProfiles: consumerProfilesModel ?? null,
      exports: exportsModel ?? null,
      referencedAssets: brandSemantics.referencedAssets,
    });

    if (packageModel.brandSystemDigest !== computedBrandSystemDigest) {
      fail(
        archCtx,
        "BRAND_SYSTEM_DIGEST_MISMATCH",
        `brand-package.toml brand_system_digest '${packageModel.brandSystemDigest}' does not match computed digest '${computedBrandSystemDigest}'.`,
      );
    }
    if (brandManifest.brandSystemDigest !== computedBrandSystemDigest) {
      fail(
        archCtx,
        "BRAND_SYSTEM_DIGEST_MISMATCH",
        `tfsb-brand-manifest.json brandSystemDigest '${brandManifest.brandSystemDigest}' does not match computed digest '${computedBrandSystemDigest}'.`,
      );
    }

    const packagedDerivedTargets = [...new Set(brandModel.bindings.filter((binding) => binding.authority === "derived").map((binding) => binding.asset))].sort(compareUtf8);
    const parsedDerivedReceipts = new Map<string, BrandDerivedReceipt>();
    const derivedManifestRecords = brandManifest.derivedReceipts ?? [];
    if (packagedDerivedTargets.length > 0 && derivedManifestRecords.length === 0) {
      fail(archCtx, "DERIVED_RECEIPT_MISSING", "Brand manifest must include derivedReceipts for packaged derived targets.");
    }
    if (derivedManifestRecords.length !== packagedDerivedTargets.length) {
      fail(archCtx, "DERIVED_RECEIPT_MISMATCH", "Brand manifest derived receipt inventory does not match packaged derived targets.");
    }
    for (const targetId of packagedDerivedTargets) {
      const manifestRecord = derivedManifestRecords.find((record) => record.targetId === targetId);
      const recipe = recipesModel?.recipes.find((candidate) => candidate.target_asset === targetId);
      if (manifestRecord === undefined || recipe === undefined || manifestRecord.recipeId !== recipe.id) {
        fail(archCtx, "DERIVED_RECEIPT_MISMATCH", `Derived target '${targetId}' lacks its exact recipe receipt record.`, targetId);
      }
      const receiptBytes = payloadBytesByPath.get(manifestRecord.bundlePath);
      if (receiptBytes === undefined) fail(archCtx, "ARCHIVE_MISSING_ENTRY", `Derived receipt '${manifestRecord.bundlePath}' is missing.`);
      let receiptText: string;
      try { receiptText = new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes); }
      catch { fail(archCtx, "ARCHIVE_INVALID_UTF8", `Derived receipt '${manifestRecord.bundlePath}' is not valid UTF-8.`); }
      const parsedReceipt = parseBrandDerivedReceipt(receiptText, manifestRecord.bundlePath);
      if (!parsedReceipt.ok) fail(archCtx, "DERIVED_RECEIPT_INVALID", `Derived receipt '${manifestRecord.bundlePath}' is invalid.`);
      const receipt = parsedReceipt.value;
      parsedDerivedReceipts.set(targetId, receipt);
      const asset = assetMap.get(targetId)!;
      const rendered = serializeSvgV2(asset.svg);
      if (!rendered.ok || receipt.targetAssetId !== targetId || receipt.recipeId !== recipe.id || receipt.receiptDigest !== manifestRecord.receiptDigest || receipt.targetModelDigest !== manifestRecord.canonicalAssetDigest || receipt.targetSvgDigest !== manifestRecord.targetSvgDigest || computeAssetSemanticDigest(asset) !== manifestRecord.canonicalAssetDigest || computeSvgOutputDigest(rendered.value) !== manifestRecord.targetSvgDigest) {
        fail(archCtx, "DERIVED_RECEIPT_MISMATCH", `Derived receipt relationships do not match target '${targetId}'.`, manifestRecord.bundlePath);
      }
      stagedFiles.set(`.tfsb/derived/${targetId}.receipt.json`, receiptBytes);
    }
    for (const record of derivedManifestRecords) {
      if (!packagedDerivedTargets.includes(record.targetId)) fail(archCtx, "DERIVED_RECEIPT_ORPHAN", `Orphan derived receipt '${record.targetId}'.`, record.bundlePath);
    }


    const qaBaselineRecords = brandManifest.qaBaselines ?? [];
    const baselineCases = qaModel?.cases.filter((entry) => entry.kind === "baseline") ?? [];
    if (qaBaselineRecords.length !== baselineCases.length) fail(archCtx, "BRAND_QA_BASELINE_MISMATCH", "Brand manifest QA baseline inventory does not match brand-qa.toml baseline cases.");
    for (const qaCase of baselineCases) {
      if (qaCase.kind !== "baseline") continue;
      const profile = qaModel!.profiles.find((candidate) => candidate.cases.includes(qaCase.id));
      const record = qaBaselineRecords.find((candidate) => candidate.profileId === profile?.id && candidate.caseId === qaCase.id);
      if (profile === undefined || record === undefined) fail(archCtx, "BRAND_QA_BASELINE_MISMATCH", `Baseline case '${qaCase.id}' lacks its exact manifest record.`);
      if (record.baselineDigest !== qaCase.baselineDigest || record.rendererId !== qaCase.rendererId || record.rendererVersion !== qaCase.rendererVersion || record.platformClaim !== qaCase.platformClaim || record.canonicalAssetDigest !== qaCase.canonicalAssetDigest || record.svgDigest !== qaCase.svgDigest || record.width !== qaCase.sizes[0]![0] || record.height !== qaCase.sizes[0]![1] || record.background !== qaCase.backgrounds[0]) fail(archCtx, "BRAND_QA_BASELINE_MISMATCH", `Baseline record metadata differs for '${qaCase.id}'.`, record.bundlePath);
      const bytes = payloadBytesByPath.get(record.bundlePath);
      if (bytes === undefined) fail(archCtx, "ARCHIVE_MISSING_ENTRY", `QA baseline '${record.bundlePath}' is missing.`);
      const digest: Sha256Digest = `sha256:${computeRawSha256(bytes)}`;
      if (digest !== record.baselineDigest) fail(archCtx, "BRAND_QA_BASELINE_DRIFT", `QA baseline '${record.bundlePath}' byte digest differs.`, record.bundlePath);
      const bindings = qaCase.asset === undefined ? brandModel.bindings.filter((binding) => binding.family === qaCase.family && (qaCase.role === undefined || binding.role === qaCase.role) && (qaCase.variant === undefined || binding.variant === qaCase.variant)) : [];
      const targetId = qaCase.asset ?? (bindings.length === 1 ? bindings[0]!.asset : undefined);
      if (targetId === undefined) fail(archCtx, "BRAND_QA_TARGET_COUNT", `Baseline case '${qaCase.id}' must resolve exactly one target.`);
      const target = assetMap.get(targetId);
      if (target === undefined) fail(archCtx, "BRAND_QA_TARGET_UNKNOWN", `Baseline target '${targetId}' is unavailable.`);
      const targetSvg = serializeSvgV2(target.svg);
      if (!targetSvg.ok || computeAssetSemanticDigest(target) !== record.canonicalAssetDigest || computeSvgOutputDigest(targetSvg.value) !== record.svgDigest) fail(archCtx, "BRAND_QA_BASELINE_INPUT_MISMATCH", `Baseline '${record.bundlePath}' input identity differs.`);
      stagedFiles.set(`.tfsb/brand-baselines/${record.profileId}/${record.caseId}.png`, bytes);
    }

    // Step 12: Companion cross-checking & staging (ADR 0014: optional companions may be absent)
    const companions: { id: string; filename: string; bytes: Uint8Array; digest: Sha256Digest }[] = [];
    const pkgCompMap = new Map(packageModel.companions.map((c) => [c.id, c]));

    // 1. Every companion present in brand manifest must match a declared package companion
    for (const maniComp of brandManifest.companions) {
      const pkgComp = pkgCompMap.get(maniComp.id);
      if (pkgComp === undefined) {
        fail(archCtx, "BRAND_PACKAGE_MISMATCH", `Brand manifest companion '${maniComp.id}' is not declared in brand-package.toml.`);
      }
      if (
        maniComp.purpose !== pkgComp.purpose ||
        maniComp.bundlePath !== pkgComp.bundlePath ||
        maniComp.canonicalCompanionFile !== pkgComp.canonicalCompanionFile ||
        maniComp.mediaType !== pkgComp.mediaType ||
        maniComp.digest !== pkgComp.digest ||
        maniComp.required !== pkgComp.required
      ) {
        fail(archCtx, "BRAND_PACKAGE_MISMATCH", `Companion '${maniComp.id}' metadata mismatch.`);
      }

      const compBytes = payloadBytesByPath.get(maniComp.bundlePath);
      if (compBytes === undefined) {
        fail(archCtx, "ARCHIVE_MISSING_ENTRY", `Companion '${maniComp.bundlePath}' is missing from payload.`);
      }
      const compDigest: Sha256Digest = `sha256:${computeRawSha256(compBytes)}`;
      if (compDigest !== maniComp.digest) {
        fail(
          archCtx,
          "COMPANION_DIGEST_MISMATCH",
          `Companion digest mismatch for '${maniComp.id}'; computed '${compDigest}', declared '${maniComp.digest}'.`,
        );
      }

      stagedFiles.set(`.tfsb/companions/${maniComp.canonicalCompanionFile}`, compBytes);
      companions.push({
        id: maniComp.id,
        filename: maniComp.canonicalCompanionFile,
        bytes: compBytes,
        digest: maniComp.digest,
      });
    }

    // 2. Every declared companion in package model that is missing from brand manifest must have required === false
    const maniCompMap = new Map(brandManifest.companions.map((c) => [c.id, c]));
    for (const pkgComp of packageModel.companions) {
      if (!maniCompMap.has(pkgComp.id)) {
        if (pkgComp.required !== false) {
          fail(archCtx, "BRAND_PACKAGE_MISMATCH", `Required package companion '${pkgComp.id}' is missing from brand bundle.`);
        }
      }
    }

    // Step 13: Generic Manifest payload 1:1 claim matching
    const claimedGenericPaths = new Set<string>();

    for (const asset of assets) {
      const assetBundlePath = `assets/${asset.filename}`;
      const rec = genericManifest.files.find(
        (f) => f.type === "asset" && f.path === assetBundlePath && f.assetId === asset.id,
      );
      if (rec === undefined) {
        fail(
          archCtx,
          "MANIFEST_COLLISION",
          `Generic manifest lacks matching asset record for '${asset.id}' at '${assetBundlePath}'.`,
        );
      }
      const payloadBytes = payloadBytesByPath.get(assetBundlePath)!;
      if (rec.sha256 !== computeRawSha256(payloadBytes)) {
        fail(archCtx, "ARCHIVE_DIGEST_MISMATCH", `Generic manifest hash mismatch for '${assetBundlePath}'.`);
      }
      claimedGenericPaths.add(assetBundlePath);
    }

    for (const comp of companions) {
      const compBundlePath = `companions/${comp.filename}`;
      const rec = genericManifest.files.find((f) => f.type === "companion" && f.path === compBundlePath);
      if (rec === undefined) {
        fail(
          archCtx,
          "MANIFEST_COLLISION",
          `Generic manifest lacks matching companion record at '${compBundlePath}'.`,
        );
      }
      if (rec.sha256 !== computeRawSha256(comp.bytes)) {
        fail(archCtx, "ARCHIVE_DIGEST_MISMATCH", `Generic manifest hash mismatch for '${compBundlePath}'.`);
      }
      claimedGenericPaths.add(compBundlePath);
    }

    for (const entry of BRAND_FILE_INVENTORY) {
      const bundlePath = `brand/${entry.filename}`;
      const fileBytes = payloadBytesByPath.get(bundlePath);
      if (fileBytes !== undefined) {
        const rec = genericManifest.files.find((f) => f.type === "file" && f.path === bundlePath);
        if (rec === undefined) {
          fail(archCtx, "MANIFEST_COLLISION", `Generic manifest lacks matching file record for '${bundlePath}'.`);
        }
        if (rec.sha256 !== computeRawSha256(fileBytes)) {
          fail(archCtx, "ARCHIVE_DIGEST_MISMATCH", `Generic manifest hash mismatch for '${bundlePath}'.`);
        }
        claimedGenericPaths.add(bundlePath);
        stagedFiles.set(entry.canonicalPath, fileBytes);
      }
    }

    for (const receipt of derivedManifestRecords) {
      const bytes = payloadBytesByPath.get(receipt.bundlePath)!;
      const rec = genericManifest.files.find((file) => file.type === "file" && file.path === receipt.bundlePath);
      if (rec === undefined || rec.sha256 !== computeRawSha256(bytes)) {
        fail(archCtx, "ARCHIVE_DIGEST_MISMATCH", `Generic manifest receipt record mismatch for '${receipt.bundlePath}'.`);
      }
      claimedGenericPaths.add(receipt.bundlePath);
    }

    for (const baseline of qaBaselineRecords) {
      const bytes = payloadBytesByPath.get(baseline.bundlePath)!;
      const rec = genericManifest.files.find((file) => file.type === "file" && file.path === baseline.bundlePath);
      if (rec === undefined || rec.sha256 !== computeRawSha256(bytes)) fail(archCtx, "ARCHIVE_DIGEST_MISMATCH", `Generic manifest baseline record mismatch for '${baseline.bundlePath}'.`);
      claimedGenericPaths.add(baseline.bundlePath);
    }

    if (claimedGenericPaths.size !== genericManifest.files.length) {
      for (const f of genericManifest.files) {
        if (!claimedGenericPaths.has(f.path)) {
          fail(
            archCtx,
            "MANIFEST_UNCLAIMED_PAYLOAD",
            `Generic manifest contains unclaimed payload entry '${f.path}'.`,
            f.path,
          );
        }
      }
    }

    // Step 14: Stage project.toml (schema 2) & provenance.json (schema 2)
    const project: NormalizedProjectV2 = {
      schemaVersion: 2,
      name: genericManifest.projectName ?? defaultProjectName(root),
      buildDirectory: "brand/dist" as ProjectRelativePath,
      installs: [],
      companions: [],
    };
    stagedFiles.set(".tfsb/project.toml", Buffer.from(serializeProjectTomlV2(project), "utf8"));

    const provenanceRecords: ImportProvenanceV2["records"] = [
      ...assets.map((asset) => {
        const canonicalDigest = computeAssetSemanticDigest(asset);
        const invItem = brandManifest.inventory.find((item) => item.assetId === asset.id)!;
        const svgBytes = payloadBytesByPath.get(invItem.bundlePath)!;
        return {
          type: "asset" as const,
          assetId: asset.id,
          canonicalPath: `.tfsb/assets/${asset.id}.toml`,
          archive: {
            archiveDigestBasis: ARCHIVE_DIGEST_BASIS,
            archiveDigest,
            entryName: invItem.bundlePath,
            sourceBasis: ARCHIVE_SOURCE_DIGEST_BASIS,
            sourceDigest: computeSha256(svgBytes),
            archiveCanonicalBasis: ASSET_DIGEST_BASIS_V2,
            archiveCanonicalDigest: canonicalDigest,
            canonicalBasis: ASSET_DIGEST_BASIS_V2,
            canonicalState: "present" as const,
            canonicalDigest,
            resolution: "aligned" as const,
            toolVersion: TOOL_VERSION,
          },
          migration: null,
          normalizationPolicy: null,
        };
      }),
      ...companions.map((companion) => {
        const byteDigest = computeCompanionByteDigest(companion.bytes);
        const compEntry = brandManifest.companions.find((c) => c.canonicalCompanionFile === companion.filename)!;
        return {
          type: "companion" as const,
          canonicalPath: `.tfsb/companions/${companion.filename}`,
          archive: {
            archiveDigestBasis: ARCHIVE_DIGEST_BASIS,
            archiveDigest,
            entryName: compEntry.bundlePath,
            sourceBasis: ARCHIVE_SOURCE_DIGEST_BASIS,
            sourceDigest: byteDigest,
            archiveCanonicalBasis: COMPANION_DIGEST_BASIS,
            archiveCanonicalDigest: byteDigest,
            canonicalBasis: COMPANION_DIGEST_BASIS,
            canonicalState: "present" as const,
            canonicalDigest: byteDigest,
            resolution: "aligned" as const,
            toolVersion: TOOL_VERSION,
          },
        };
      }),
    ];

    stagedFiles.set(
      ".tfsb/provenance.json",
      Buffer.from(
        serializeImportProvenanceV2({
          kind: "tfsb-import-provenance",
          schemaVersion: 2,
          records: provenanceRecords,
        }),
        "utf8",
      ),
    );

    const finalStat = await handle.stat();
    const finalLstat = await lstat(archivePath).catch(() => undefined);
    if (
      finalLstat === undefined ||
      !sameFileIdentity(fileIdentity(stat), fileIdentity(finalStat)) ||
      !sameFileIdentity(fileIdentity(finalStat), fileIdentity(finalLstat))
    ) {
      fail(archCtx, "ARCHIVE_CHANGED_DURING_PLAN", "Archive changed during candidate inspection.");
    }

    const filesDto: BrandImportFileSummary[] = [];
    for (const [path, bytes] of stagedFiles) {
      filesDto.push({
        path,
        size: bytes.byteLength,
        sha256: computeRawSha256(bytes),
      });
    }
    filesDto.sort((a, b) => compareUtf8(a.path, b.path));

    const companionsDto: BrandImportCompanionSummary[] = companions.map((c) => ({
      id: c.id,
      filename: c.filename,
      size: c.bytes.byteLength,
      digest: c.digest,
    }));
    companionsDto.sort((a, b) => compareUtf8(a.id, b.id));

    const domainModelByName = new Map<string, unknown>([["tokens", tokensModel], ["recipes", recipesModel], ["qa", qaModel], ["consumer_profiles", consumerProfilesModel], ["package", packageModel], ["exports", exportsModel]]);
    const domains = BRAND_FILE_INVENTORY.filter((entry) => entry.domain !== "brand").map((entry) => {
      const enabled = entry.domain === "consumer_profiles" ? brandModel.enabledDomains.consumerProfiles : brandModel.enabledDomains[entry.domain as keyof typeof brandModel.enabledDomains];
      const present = payloadBytesByPath.has(`brand/${entry.filename}`);
      return Object.freeze({ domain: entry.domain, canonicalPath: entry.canonicalPath, enabled, state: enabled ? domainModelByName.get(entry.domain) !== undefined ? "available" as const : "declared-unavailable" as const : "disabled" as const, present });
    });
    const derivedEntries = (brandManifest.derivedReceipts ?? []).map((record) => Object.freeze({ targetAssetId: record.targetId, recipeId: record.recipeId, state: "unchanged" as const, receiptDigest: record.receiptDigest, targetModelDigest: record.canonicalAssetDigest, targetSvgDigest: record.targetSvgDigest }));
    const zeroCounts = { unchanged: derivedEntries.length, "stale-authority": 0, "missing-target": 0, "human-owned": 0, "target-drift": 0, "invalid-receipt": 0, "ownership-conflict": 0 } as const;
    const brandFiles = new Map(BRAND_FILE_INVENTORY.flatMap((entry) => {
      const bytes = payloadBytesByPath.get(`brand/${entry.filename}`);
      return bytes === undefined ? [] : [[entry.canonicalPath, bytes] as const];
    }));
    const loadedBrand = Object.freeze({ model: brandModel, ...(tokensModel === undefined ? {} : { tokensModel }), ...(recipesModel === undefined ? {} : { recipesModel }), ...(qaModel === undefined ? {} : { qaModel }), ...(consumerProfilesModel === undefined ? {} : { consumerProfilesModel, consumerProfilesDigest: computeConsumerProfilesDomainDigest(consumerProfilesModel) }), ...(exportsModel === undefined ? {} : { exportsModel, exportsDigest: computeBrandExportsDomainDigest(exportsModel), rawExportsFileDigest: computeRawBrandExportsFileDigest(exportsModel) }), packageModel, brandDigest: computedBrandDigest, ...(tokensModel === undefined ? {} : { tokensDigest: computeBrandTokensDigest(tokensModel) }), ...(recipesModel === undefined ? {} : { recipesDigest: computeBrandRecipesDigest(recipesModel) }), ...(qaModel === undefined ? {} : { qaDigest: computeBrandQaDigest(qaModel) }), brandSystemDigest: computedBrandSystemDigest, brandPackageDigest: computedPkgDigest, domains: Object.freeze(domains), brandFiles, referencedAssets: brandSemantics.referencedAssets, completeness: brandSemantics.completeness });
    const companionBytes = new Map(companions.map((entry) => [entry.filename, entry.bytes]));
    const diffSnapshot = createBrandDiffSnapshot({ brand: loadedBrand, assets, companions: companionBytes } as unknown as LoadedProject, derivedEntries.length === 0 ? undefined : { entries: Object.freeze(derivedEntries), counts: zeroCounts }, parsedDerivedReceipts);

    const plan: BrandImportPlan = deepCloneAndFreezePlain({
      root,
      archive: options.archive,
      archiveDigest,
      project,
      brandModel,
      packageModel,
      brandManifest,
      ...(consumerProfilesModel === undefined ? {} : { consumerProfilesModel }),
      ...(exportsModel === undefined ? {} : { exportsModel }),
      assets,
      companions: companionsDto,
      files: filesDto,
      [brandImportPlanBrand]: true,
    });

    brandImportInternals.set(plan, {
      canonicalSnapshot,
      archiveSnapshot: Object.freeze({
        path: archivePath,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      }),
      nextFiles: new Map(stagedFiles),
      brandModel: deepCloneAndFreezePlain(brandModel),
      packageModel: deepCloneAndFreezePlain(packageModel),
      brandManifest: deepCloneAndFreezePlain(brandManifest),
      expectedAssets: deepCloneAndFreezePlain(assets),
      expectedCompanions: companions.map((c) => ({
        id: c.id,
        filename: c.filename,
        bytes: new Uint8Array(c.bytes),
        digest: c.digest,
      })),
      archiveHandle: handle,
      diffSnapshot,
      canonicalSvgBytes,
      disposed: false,
    });

    return plan;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function planBrandImport(options: BrandImportOptions): Promise<BrandImportPlan> {
  return inspectBrandImportCandidate(options, false);
}

export async function inspectVerifiedBrandArchive(options: Pick<BrandImportOptions, "archive" | "root">): Promise<BrandDiffSnapshot> {
  const plan = await inspectBrandImportCandidate(options, true);
  const internals = brandImportInternals.get(plan);
  if (internals === undefined) throw new Error("Verified archive inspection state is unavailable.");
  try { return internals.diffSnapshot; }
  finally { await disposeBrandImportPlan(plan); }
}

/** Internal retained verifier seam used by the offline consumer planner. Not re-exported from the package root. */
export async function retainVerifiedBrandArchive(options: Pick<BrandImportOptions, "archive" | "root">): Promise<BrandImportPlan> {
  return inspectBrandImportCandidate(options, true);
}

/** Internal retained Studio diff seam. Not re-exported from the package root. */
export function getRetainedBrandImportDiffSnapshot(plan: BrandImportPlan): BrandDiffSnapshot {
  const internals = brandImportInternals.get(plan);
  if (internals === undefined || internals.disposed) {
    fail(context(), "IMPORT_INVALID_PLAN", "Verified archive authority is unavailable.");
  }
  return internals.diffSnapshot;
}

/** Internal retained Studio visual-evidence seam. Not re-exported from the package root. */
export function getRetainedBrandImportVisualAsset(plan: BrandImportPlan, assetId: string): { readonly asset: NormalizedAssetV2; readonly svgBytes: Uint8Array } {
  const internals = brandImportInternals.get(plan);
  if (internals === undefined || internals.disposed) fail(context(), "IMPORT_INVALID_PLAN", "Verified archive authority is unavailable.");
  const asset = internals.expectedAssets.find((entry) => entry.id === assetId);
  const bytes = internals.canonicalSvgBytes.get(assetId);
  if (asset === undefined || bytes === undefined) fail(context(), "IMPORT_INVALID_PLAN", "Verified visual asset authority is unavailable.");
  return Object.freeze({ asset, svgBytes: new Uint8Array(bytes) });
}

/** Revalidate the exact opened archive identity and bytes retained by a verifier plan. */
export async function revalidateRetainedBrandArchive(plan: BrandImportPlan): Promise<void> {
  const internals = brandImportInternals.get(plan);
  if (internals === undefined || internals.disposed) fail(context(), "IMPORT_INVALID_PLAN", "Verified archive authority is unavailable.");
  const current = await lstat(internals.archiveSnapshot.path).catch(() => undefined);
  if (current === undefined || current.isSymbolicLink() || !current.isFile()) fail(context(), "ARCHIVE_CHANGED_DURING_PLAN", "Verified archive carrier is unavailable.");
  const opened = await internals.archiveHandle.stat();
  if (!sameFileIdentity(fileIdentity(current), fileIdentity(opened))) fail(context(), "ARCHIVE_CHANGED_DURING_PLAN", "Verified archive carrier identity changed.");
  const digest = await hashOpenArchive(internals.archiveHandle, opened.size, archiveContext(internals.archiveSnapshot.path));
  if (digest !== plan.archiveDigest) fail(context(), "ARCHIVE_CHANGED_DURING_PLAN", "Verified archive bytes changed.");
}

/** Internal byte read restricted to an already verified declared companion. */
export function readRetainedBrandArchiveCompanion(plan: BrandImportPlan, companionId: string): Uint8Array | undefined {
  const internals = brandImportInternals.get(plan);
  if (internals === undefined || internals.disposed) fail(context(), "IMPORT_INVALID_PLAN", "Verified archive authority is unavailable.");
  const record = internals.packageModel.companions.find((entry) => entry.id === companionId);
  if (record === undefined) return undefined;
  const bytes = internals.nextFiles.get(`.tfsb/companions/${record.canonicalCompanionFile}`);
  return bytes === undefined ? undefined : Buffer.from(bytes);
}

async function validateStagedBrandTree(
  stageRoot: string,
  internals: BrandImportTransactionInternals,
): Promise<void> {
  const ctx = context(internals.archiveSnapshot.path);

  // 1. Enumerate all staged entries recursively with bounds
  const stagedFilesOnDisk = new Map<string, Uint8Array>();
  let totalScanned = 0;
  let aggregateSize = 0;

  async function scan(currentDir: string, relDir: string) {
    const dirStatBefore = await lstat(currentDir);
    if (!dirStatBefore.isDirectory() || dirStatBefore.isSymbolicLink() || (dirStatBefore.mode & 0o777) !== 0o700) {
      fail(ctx, "IMPORT_UNSAFE_TYPE", `Staged directory '${relDir}' has unsafe type or permissions.`, relDir);
    }
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      totalScanned += 1;
      if (totalScanned > BRAND_IMPORT_LIMITS.totalEntries + 10) {
        fail(ctx, "IMPORT_LIMIT_EXCEEDED", "Staged tree exceeds entry count limit.");
      }
      const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const fullPath = join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        fail(ctx, "IMPORT_UNSAFE_TYPE", `Staged file '${relPath}' is a symbolic link.`, relPath);
      }
      if (entry.isDirectory()) {
        await scan(fullPath, relPath);
      } else if (entry.isFile()) {
        const { bytes, snapshot } = await readRegularFileSnapshot(
          fullPath,
          ctx,
          "IMPORT_UNSAFE_TYPE",
          `Staged file '${relPath}' changed or became unsafe during validation.`,
          relPath.startsWith("brand-baselines/") ? BRAND_IMPORT_LIMITS.baselineEntryBytes : BRAND_IMPORT_LIMITS.selectedEntryBytes,
        );
        if ((snapshot.mode & 0o777) !== 0o600) {
          fail(ctx, "IMPORT_UNSAFE_TYPE", `Staged file '${relPath}' has unsafe permissions.`, relPath);
        }
        aggregateSize += bytes.byteLength;
        if (aggregateSize > BRAND_IMPORT_LIMITS.selectedAggregateBytes) {
          fail(ctx, "IMPORT_LIMIT_EXCEEDED", "Staged tree exceeds aggregate size limit.");
        }

        const canonicalRelPath = `.tfsb/${relPath}`;
        stagedFilesOnDisk.set(canonicalRelPath, bytes);
      } else {
        fail(ctx, "IMPORT_UNSAFE_TYPE", `Staged file '${relPath}' is not a regular file.`, relPath);
      }
    }
    const dirStatAfter = await lstat(currentDir);
    if (
      !dirStatAfter.isDirectory() ||
      dirStatAfter.isSymbolicLink() ||
      !sameFileIdentity(identity(dirStatBefore), identity(dirStatAfter))
    ) {
      fail(ctx, "IMPORT_UNSAFE_TYPE", `Staged directory '${relDir}' changed during scan.`, relDir);
    }
  }

  await scan(stageRoot, "");

  // 2. Exact match against internals.nextFiles
  if (stagedFilesOnDisk.size !== internals.nextFiles.size) {
    fail(
      ctx,
      "IMPORT_TRANSACTION_FAILED",
      `Staged file count ${stagedFilesOnDisk.size} does not match expected ${internals.nextFiles.size}.`,
    );
  }

  for (const [relPath, expectedBytes] of internals.nextFiles) {
    const actualBytes = stagedFilesOnDisk.get(relPath);
    if (actualBytes === undefined) {
      fail(ctx, "IMPORT_TRANSACTION_FAILED", `Expected staged file '${relPath}' is missing from stage.`);
    }
    if (actualBytes.byteLength !== expectedBytes.byteLength || Buffer.compare(actualBytes, expectedBytes) !== 0) {
      fail(ctx, "IMPORT_TRANSACTION_FAILED", `Staged file '${relPath}' content has been modified or corrupted.`);
    }
  }

  // 3. Re-parse and validate models on disk using fatal UTF-8
  const projectBytes = stagedFilesOnDisk.get(".tfsb/project.toml");
  if (projectBytes === undefined) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Missing staged .tfsb/project.toml");
  let projectText: string;
  try {
    projectText = new TextDecoder("utf-8", { fatal: true }).decode(projectBytes);
  } catch {
    fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/project.toml is not valid UTF-8.");
  }
  const parsedProject = parseProjectTomlV2(projectText, ".tfsb/project.toml");
  if (!parsedProject.ok) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/project.toml failed validation.");

  const provBytes = stagedFilesOnDisk.get(".tfsb/provenance.json");
  if (provBytes === undefined) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Missing staged .tfsb/provenance.json");
  let provText: string;
  try {
    provText = new TextDecoder("utf-8", { fatal: true }).decode(provBytes);
  } catch {
    fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/provenance.json is not valid UTF-8.");
  }
  const parsedProv = parseImportProvenanceV2(provText, ".tfsb/provenance.json");
  if (!parsedProv.ok || parsedProv.value.schemaVersion !== 2) {
    fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/provenance.json failed schema-2 validation.");
  }
  if (parsedProv.value.records.length !== internals.expectedAssets.length + internals.expectedCompanions.length) {
    fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged provenance records count does not match expected assets and companions.");
  }

  const brandTomlBytes = stagedFilesOnDisk.get(".tfsb/brand.toml");
  if (brandTomlBytes === undefined) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Missing staged .tfsb/brand.toml");
  let brandTomlText: string;
  try {
    brandTomlText = new TextDecoder("utf-8", { fatal: true }).decode(brandTomlBytes);
  } catch {
    fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand.toml is not valid UTF-8.");
  }
  const parsedBrand = parseBrandToml(brandTomlText, ".tfsb/brand.toml");
  if (!parsedBrand.ok) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand.toml failed validation.");

  const brandPkgBytes = stagedFilesOnDisk.get(".tfsb/brand-package.toml");
  if (brandPkgBytes === undefined) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Missing staged .tfsb/brand-package.toml");
  let brandPkgText: string;
  try {
    brandPkgText = new TextDecoder("utf-8", { fatal: true }).decode(brandPkgBytes);
  } catch {
    fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand-package.toml is not valid UTF-8.");
  }
  const parsedPkg = parseBrandPackageToml(brandPkgText, ".tfsb/brand-package.toml");
  if (!parsedPkg.ok) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand-package.toml failed validation.");

  const stagedAssetMap = new Map<string, NormalizedAssetV2>();
  for (const expAsset of internals.expectedAssets) {
    const assetTomlBytes = stagedFilesOnDisk.get(`.tfsb/assets/${expAsset.id}.toml`);
    if (assetTomlBytes === undefined) {
      fail(ctx, "IMPORT_TRANSACTION_FAILED", `Missing staged asset .tfsb/assets/${expAsset.id}.toml`);
    }
    let assetTomlText: string;
    try {
      assetTomlText = new TextDecoder("utf-8", { fatal: true }).decode(assetTomlBytes);
    } catch {
      fail(ctx, "IMPORT_TRANSACTION_FAILED", `Staged asset '${expAsset.id}' TOML is not valid UTF-8.`);
    }
    const parsedAsset = parseAssetTomlV2(assetTomlText, `.tfsb/assets/${expAsset.id}.toml`);
    if (!parsedAsset.ok) fail(ctx, "IMPORT_TRANSACTION_FAILED", `Staged asset '${expAsset.id}' failed validation.`);
    stagedAssetMap.set(expAsset.id, parsedAsset.value);

    const computedAssetDigest = computeAssetSemanticDigest(parsedAsset.value);
    const originalAsset = internals.expectedAssets.find((a) => a.id === expAsset.id);
    if (originalAsset === undefined || computeAssetSemanticDigest(originalAsset) !== computedAssetDigest) {
      fail(ctx, "IMPORT_TRANSACTION_FAILED", `Staged asset '${expAsset.id}' semantic digest mismatch.`);
    }
  }

  let stagedTokensModel: BrandTokensModel | undefined;
  const stagedTokensBytes = stagedFilesOnDisk.get(".tfsb/brand-tokens.toml");
  if (stagedTokensBytes !== undefined) {
    let tokText: string;
    try {
      tokText = new TextDecoder("utf-8", { fatal: true }).decode(stagedTokensBytes);
    } catch {
      fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand-tokens.toml is not valid UTF-8.");
    }
    const parsedTok = parseBrandTokensToml(tokText, ".tfsb/brand-tokens.toml");
    if (!parsedTok.ok) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand-tokens.toml failed validation.");
    stagedTokensModel = parsedTok.value;
  }

  let stagedRecipesModel: BrandRecipesModel | undefined;
  const stagedRecipesBytes = stagedFilesOnDisk.get(".tfsb/brand-recipes.toml");
  if (stagedRecipesBytes !== undefined) {
    let recText: string;
    try {
      recText = new TextDecoder("utf-8", { fatal: true }).decode(stagedRecipesBytes);
    } catch {
      fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand-recipes.toml is not valid UTF-8.");
    }
    const parsedRec = parseBrandRecipesToml(recText, ".tfsb/brand-recipes.toml");
    if (!parsedRec.ok) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand-recipes.toml failed validation.");
    stagedRecipesModel = parsedRec.value;
  }

  let stagedQaModel: BrandQaModel | undefined;
  const stagedQaBytes = stagedFilesOnDisk.get(".tfsb/brand-qa.toml");
  if (stagedQaBytes !== undefined) {
    let qaText: string;
    try { qaText = new TextDecoder("utf-8", { fatal: true }).decode(stagedQaBytes); }
    catch { fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand-qa.toml is not valid UTF-8."); }
    const parsedQa = parseBrandQaToml(qaText, ".tfsb/brand-qa.toml");
    if (!parsedQa.ok) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand-qa.toml failed validation.");
    stagedQaModel = parsedQa.value;
    if (computeBrandQaDigest(stagedQaModel) !== internals.brandManifest.domainDigests.qa) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged brand-qa.toml digest mismatch.");
    for (const record of internals.brandManifest.qaBaselines ?? []) {
      const bytes = stagedFilesOnDisk.get(`.tfsb/brand-baselines/${record.profileId}/${record.caseId}.png`);
      if (bytes === undefined || `sha256:${computeRawSha256(bytes)}` !== record.baselineDigest) fail(ctx, "IMPORT_TRANSACTION_FAILED", `Staged QA baseline '${record.profileId}/${record.caseId}' failed integrity validation.`);
    }
  }

  let stagedConsumerProfilesModel: ConsumerProfilesModel | undefined;
  const stagedConsumerProfilesBytes = stagedFilesOnDisk.get(".tfsb/consumer-profiles.toml");
  if (stagedConsumerProfilesBytes !== undefined) {
    let profileText: string;
    try { profileText = new TextDecoder("utf-8", { fatal: true }).decode(stagedConsumerProfilesBytes); }
    catch { fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/consumer-profiles.toml is not valid UTF-8."); }
    const parsedProfiles = parseConsumerProfilesToml(profileText, ".tfsb/consumer-profiles.toml");
    if (!parsedProfiles.ok) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/consumer-profiles.toml failed validation.");
    stagedConsumerProfilesModel = parsedProfiles.value;
    if (computeConsumerProfilesDomainDigest(stagedConsumerProfilesModel) !== internals.brandManifest.domainDigests.consumer_profiles) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged consumer profile digest mismatch.");
  }

  let stagedExportsModel: BrandExportsModel | undefined;
  const stagedExportsBytes = stagedFilesOnDisk.get(".tfsb/brand-exports.toml");
  if (stagedExportsBytes !== undefined) {
    let exportsText: string;
    try { exportsText = new TextDecoder("utf-8", { fatal: true }).decode(stagedExportsBytes); }
    catch { fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand-exports.toml is not valid UTF-8."); }
    const parsedExports = parseBrandExportsToml(exportsText, ".tfsb/brand-exports.toml");
    if (!parsedExports.ok) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged .tfsb/brand-exports.toml failed validation.");
    stagedExportsModel = parsedExports.value;
    if (computeBrandExportsDomainDigest(stagedExportsModel) !== internals.brandManifest.domainDigests.exports) fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged export domain digest mismatch.");
  }

  const brandSemantics = validateBrandSemantics(parsedBrand.value, stagedAssetMap, ctx, stagedRecipesModel);
  if (stagedExportsModel !== undefined) validateBrandExportSemantics(stagedExportsModel, parsedBrand.value, stagedTokensModel, stagedAssetMap, ctx);
  if (!brandSemantics.completeness.satisfied) {
    fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged brand semantics are not satisfied.");
  }

  const stagedBrandDigest = computeBrandDigest(parsedBrand.value);
  if (stagedBrandDigest !== internals.brandManifest.domainDigests.brand) {
    fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged brand.toml digest mismatch.");
  }

  const stagedPkgDigest = computeBrandPackageDigest(parsedPkg.value);
  if (stagedPkgDigest !== internals.brandManifest.brandPackageDigest) {
    fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged brand-package.toml digest mismatch.");
  }

  const stagedBrandSystemDigest = computeBrandSystemDigest({
    brand: parsedBrand.value,
    tokens: stagedTokensModel ? toBrandTokensCanonicalDto(stagedTokensModel) : null,
    recipes: stagedRecipesModel ? toBrandRecipesCanonicalDto(stagedRecipesModel) : null,
    qa: stagedQaModel === undefined ? null : toBrandQaCanonicalDto(stagedQaModel),
    consumerProfiles: stagedConsumerProfilesModel ?? null,
    exports: stagedExportsModel ?? null,
    referencedAssets: brandSemantics.referencedAssets,
  });

  if (stagedBrandSystemDigest !== internals.brandManifest.brandSystemDigest || stagedBrandSystemDigest !== parsedPkg.value.brandSystemDigest) {
    fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged brand system digest mismatch.");
  }

  // Verify cross links between package inventory and brand bindings
  if (parsedPkg.value.inventory.length !== parsedBrand.value.bindings.length) {
    fail(ctx, "IMPORT_TRANSACTION_FAILED", "Staged package inventory count does not match brand bindings count.");
  }
  for (const binding of parsedBrand.value.bindings) {
    const found = parsedPkg.value.inventory.find(
      (item) =>
        item.family === binding.family &&
        item.role === binding.role &&
        item.variant === binding.variant &&
        item.asset === binding.asset,
    );
    if (found === undefined) {
      fail(ctx, "IMPORT_TRANSACTION_FAILED", `Staged binding '${binding.family}:${binding.role}:${binding.variant}' missing from package inventory.`);
    }
  }
  if (stagedRecipesModel !== undefined) {
    const fileViews = new Map([...stagedFilesOnDisk].map(([path, bytes]) => [path, { bytes, digest: computeSha256(bytes) }] as const));
    const derivedInspection = inspectDerivedAuthority(fileViews, { operation: "import", domain: "brand" });
    const invalidDerived = derivedInspection.entries.find((entry) => entry.state !== "unchanged");
    if (invalidDerived !== undefined) {
      fail(ctx, "IMPORT_TRANSACTION_FAILED", `Staged derived target '${invalidDerived.targetAssetId}' is ${invalidDerived.state}.`, invalidDerived.targetAssetId);
    }
  }
}

export async function executeBrandImport(plan: BrandImportPlan, hooks?: TransactionHooks): Promise<void> {
  const internals = brandImportInternals.get(plan);
  if (internals === undefined || internals.disposed || (plan as any)?.[brandImportPlanBrand] !== true) {
    fail(context(plan?.archive), "IMPORT_INVALID_PLAN", "Brand import apply requires an authentic private plan.");
  }

  try {
    await executeCanonicalTransaction({
      root: plan.root,
      nextFiles: internals.nextFiles,
      expectedSnapshot: internals.canonicalSnapshot,
      archiveSnapshot: internals.archiveSnapshot,
      ...(hooks === undefined ? {} : { hooks }),
      operation: "import",
      verifyExternalState: async () => {
        const currentLstat = await lstat(internals.archiveSnapshot.path).catch(() => undefined);
        if (currentLstat === undefined || currentLstat.isSymbolicLink() || !currentLstat.isFile()) {
          fail(context(plan.archive), "ARCHIVE_READ_FAILED", "Archive became missing or invalid before canonical transaction.");
        }
        const openedStat = await internals.archiveHandle.stat();
        if (!sameFileIdentity(fileIdentity(currentLstat), fileIdentity(openedStat))) {
          fail(context(plan.archive), "ARCHIVE_CHANGED_DURING_PLAN", "Archive was replaced or mutated before canonical transaction.");
        }
        const rehashedDigest = await hashOpenArchive(internals.archiveHandle, openedStat.size, archiveContext(internals.archiveSnapshot.path));
        if (rehashedDigest !== plan.archiveDigest) {
          fail(context(plan.archive), "ARCHIVE_CHANGED_DURING_PLAN", "Archive content changed before canonical transaction.");
        }
      },
      validateStagedTree: async (stageRoot: string) => {
        await validateStagedBrandTree(stageRoot, internals);
      },
    });
  } finally {
    await disposeBrandImportPlan(plan);
  }
}

export async function importBrandProject(options: BrandImportOptions): Promise<BrandImportPlan> {
  const plan = await planBrandImport(options);
  if (options.dryRun === true) {
    await disposeBrandImportPlan(plan);
    return plan;
  }
  await executeBrandImport(plan);
  return plan;
}
