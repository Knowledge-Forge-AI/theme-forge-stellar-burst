import { ASSET_DIGEST_BASIS_V2, type Sha256Digest } from "./digests.js";
import { DiagnosticError, fail, fromCaught, ok, type DiagnosticContext } from "./diagnostics.js";
import type { NormalizationPolicyIdentityV1 } from "./normalization-policy.js";
import { PROVENANCE_KIND, compareUtf8 } from "./provenance.js";
import {
  COMPANION_DIGEST_BASIS,
  parseImportProvenanceV2,
  type ArchiveCheckpointV2,
  type ImportProvenanceV2,
  type MigrationEvidenceV2,
} from "./provenance2.js";
import { DIRECTORY_FILE_BYTES_BASIS, DIRECTORY_SNAPSHOT_BASIS } from "./directory-snapshot.js";
import { SOURCE_MAP_DIGEST_BASIS } from "./source-map.js";
import type { Result } from "./types.js";

export const PROVENANCE_SCHEMA_VERSION_V3 = 3 as const;

export interface ArchiveSourceCheckpointV3 extends ArchiveCheckpointV2 {
  readonly kind: "archive";
}

export type DirectoryCanonicalBasisV3 = typeof ASSET_DIGEST_BASIS_V2 | typeof COMPANION_DIGEST_BASIS;
export type DirectoryCheckpointStateV3 = "present" | "absent";
export type DirectoryResolutionV3 = "aligned" | "canonical";

export interface DirectorySourceCheckpointV3 {
  readonly kind: "directory";
  readonly collectionId: string;
  readonly sourcePath: string;
  readonly sourceMapBasis: typeof SOURCE_MAP_DIGEST_BASIS;
  readonly sourceMapDigest: Sha256Digest;
  readonly snapshotBasis: typeof DIRECTORY_SNAPSHOT_BASIS;
  readonly snapshotDigest: Sha256Digest;
  readonly sourceBasis: typeof DIRECTORY_FILE_BYTES_BASIS;
  readonly sourceState: DirectoryCheckpointStateV3;
  readonly sourceDigest: Sha256Digest | null;
  readonly sourceCanonicalBasis: DirectoryCanonicalBasisV3;
  readonly sourceCanonicalDigest: Sha256Digest | null;
  readonly canonicalBasis: DirectoryCanonicalBasisV3;
  readonly canonicalState: DirectoryCheckpointStateV3;
  readonly canonicalDigest: Sha256Digest | null;
  readonly resolution: DirectoryResolutionV3;
  readonly toolVersion: string;
}

export type ProvenanceSourceCheckpointV3 = ArchiveSourceCheckpointV3 | DirectorySourceCheckpointV3;

export interface AssetProvenanceRecordV3 {
  readonly type: "asset";
  readonly assetId: string;
  readonly canonicalPath: string;
  readonly source: ProvenanceSourceCheckpointV3 | null;
  readonly migration: MigrationEvidenceV2 | null;
  readonly normalizationPolicy: NormalizationPolicyIdentityV1 | null;
}

export interface CompanionProvenanceRecordV3 {
  readonly type: "companion";
  readonly canonicalPath: string;
  readonly source: ProvenanceSourceCheckpointV3;
}

export type ProvenanceRecordV3 = AssetProvenanceRecordV3 | CompanionProvenanceRecordV3;

export interface ImportProvenanceV3 {
  readonly kind: typeof PROVENANCE_KIND;
  readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION_V3;
  readonly records: readonly ProvenanceRecordV3[];
}

function context(source?: string): DiagnosticContext {
  return { operation: "reconcile", domain: "provenance", ...(source === undefined ? {} : { source }) };
}

function object(value: unknown, ctx: DiagnosticContext, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ctx, "PROVENANCE_INVALID_TYPE", "Provenance value must be an object.", location);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], ctx: DiagnosticContext, location: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) fail(ctx, "PROVENANCE_UNKNOWN_FIELD", `Unknown provenance field '${unknown}'.`, `${location}.${unknown}`);
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) fail(ctx, "PROVENANCE_MISSING_FIELD", `Required provenance field '${missing}' is missing.`, `${location}.${missing}`);
}

function text(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string" || value === "") fail(ctx, "PROVENANCE_INVALID_TYPE", "Expected a non-empty string.", location);
  return value;
}

function digest(value: unknown, ctx: DiagnosticContext, location: string): Sha256Digest {
  const parsed = text(value, ctx, location);
  if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) fail(ctx, "PROVENANCE_INVALID_DIGEST", "Expected a lowercase sha256 digest.", location);
  return parsed as Sha256Digest;
}

function portablePath(value: unknown, ctx: DiagnosticContext, location: string): string {
  const parsed = text(value, ctx, location);
  const components = parsed.split("/");
  if (parsed !== parsed.normalize("NFC") || parsed.includes("\\") || parsed.includes("\0") || parsed.startsWith("/") || /^[A-Za-z]:/.test(parsed) || components.some((part) => part === "" || part === "." || part === "..")) {
    fail(ctx, "PROVENANCE_INVALID_PATH", "Directory source path is not normalized and portable.", location);
  }
  return parsed;
}

function unwrapV2<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Provenance diagnostics were unexpectedly empty.");
  throw new DiagnosticError(first);
}

function parseArchive(value: Record<string, unknown>, recordType: "asset" | "companion", ctx: DiagnosticContext, location: string): ArchiveSourceCheckpointV3 {
  exactKeys(value, ["kind", "archiveDigestBasis", "archiveDigest", "entryName", "sourceBasis", "sourceDigest", "archiveCanonicalBasis", "archiveCanonicalDigest", "canonicalBasis", "canonicalState", "canonicalDigest", "resolution", "toolVersion"], ctx, location);
  if (value.kind !== "archive") fail(ctx, "PROVENANCE_INVALID_SOURCE_KIND", "Unknown provenance source kind.", `${location}.kind`);
  const { kind: _kind, ...archive } = value;
  const record = recordType === "asset"
    ? { type: "asset", assetId: "probe", canonicalPath: ".tfsb/assets/probe.toml", archive, migration: null, normalizationPolicy: null }
    : { type: "companion", canonicalPath: ".tfsb/companions/probe.txt", archive };
  const parsed = unwrapV2(parseImportProvenanceV2(JSON.stringify({ kind: PROVENANCE_KIND, schemaVersion: 2, records: [record] })));
  const checkpoint = parsed.records[0];
  if (checkpoint === undefined || checkpoint.archive === null) throw new Error("Schema-2 archive checkpoint validation returned no checkpoint.");
  return { kind: "archive", ...checkpoint.archive };
}

function parseV2AssetFields(
  migration: unknown,
  normalizationPolicy: unknown,
): Pick<AssetProvenanceRecordV3, "migration" | "normalizationPolicy"> {
  const parsed = unwrapV2(parseImportProvenanceV2(JSON.stringify({
    kind: PROVENANCE_KIND,
    schemaVersion: 2,
    records: [{ type: "asset", assetId: "probe", canonicalPath: ".tfsb/assets/probe.toml", archive: null, migration, normalizationPolicy }],
  })));
  const record = parsed.records[0];
  if (record?.type !== "asset") throw new Error("Schema-2 asset field validation returned no asset.");
  return { migration: record.migration, normalizationPolicy: record.normalizationPolicy };
}

function parseDirectory(value: Record<string, unknown>, recordType: "asset" | "companion", ctx: DiagnosticContext, location: string): DirectorySourceCheckpointV3 {
  exactKeys(value, ["kind", "collectionId", "sourcePath", "sourceMapBasis", "sourceMapDigest", "snapshotBasis", "snapshotDigest", "sourceBasis", "sourceState", "sourceDigest", "sourceCanonicalBasis", "sourceCanonicalDigest", "canonicalBasis", "canonicalState", "canonicalDigest", "resolution", "toolVersion"], ctx, location);
  if (value.kind !== "directory") fail(ctx, "PROVENANCE_INVALID_SOURCE_KIND", "Unknown provenance source kind.", `${location}.kind`);
  const collectionId = text(value.collectionId, ctx, `${location}.collectionId`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(collectionId)) fail(ctx, "PROVENANCE_INVALID_COLLECTION_ID", "Directory collection id is invalid.", `${location}.collectionId`);
  const sourcePath = portablePath(value.sourcePath, ctx, `${location}.sourcePath`);
  if (value.sourceMapBasis !== SOURCE_MAP_DIGEST_BASIS || value.snapshotBasis !== DIRECTORY_SNAPSHOT_BASIS || value.sourceBasis !== DIRECTORY_FILE_BYTES_BASIS) {
    fail(ctx, "PROVENANCE_UNSUPPORTED_DIGEST_BASIS", "Unsupported directory provenance digest basis.", location);
  }
  const expectedBasis: DirectoryCanonicalBasisV3 = recordType === "asset" ? ASSET_DIGEST_BASIS_V2 : COMPANION_DIGEST_BASIS;
  if (value.sourceCanonicalBasis !== expectedBasis || value.canonicalBasis !== expectedBasis) {
    fail(ctx, "PROVENANCE_UNSUPPORTED_DIGEST_BASIS", `Directory ${recordType} relation uses an invalid canonical basis.`, location);
  }
  if (value.sourceState !== "present" && value.sourceState !== "absent") fail(ctx, "PROVENANCE_INVALID_STATE", "Source state must be present or absent.", `${location}.sourceState`);
  if (value.canonicalState !== "present" && value.canonicalState !== "absent") fail(ctx, "PROVENANCE_INVALID_STATE", "Canonical state must be present or absent.", `${location}.canonicalState`);
  const sourceDigest = value.sourceDigest === null ? null : digest(value.sourceDigest, ctx, `${location}.sourceDigest`);
  const sourceCanonicalDigest = value.sourceCanonicalDigest === null ? null : digest(value.sourceCanonicalDigest, ctx, `${location}.sourceCanonicalDigest`);
  const canonicalDigest = value.canonicalDigest === null ? null : digest(value.canonicalDigest, ctx, `${location}.canonicalDigest`);
  if ((value.sourceState === "present") !== (sourceDigest !== null)) fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Source state and digest disagree.", location);
  if (value.sourceState === "absent" && sourceCanonicalDigest !== null) fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "An absent source cannot have a canonical candidate digest.", location);
  if ((value.canonicalState === "present") !== (canonicalDigest !== null)) fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Canonical state and digest disagree.", location);
  if (value.resolution !== "aligned" && value.resolution !== "canonical") fail(ctx, "PROVENANCE_INVALID_RESOLUTION", "Resolution must be aligned or canonical.", `${location}.resolution`);
  if (value.resolution === "aligned" && (value.sourceState !== "present" || value.canonicalState !== "present" || sourceCanonicalDigest === null || sourceCanonicalDigest !== canonicalDigest)) {
    fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Aligned checkpoints require present equal source-candidate and canonical digests.", location);
  }
  if (value.resolution === "canonical" && value.sourceState === "present" && value.canonicalState === "present" && sourceCanonicalDigest !== null && sourceCanonicalDigest === canonicalDigest) {
    fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Canonical ownership requires divergence or accepted absence.", location);
  }
  return {
    kind: "directory",
    collectionId,
    sourcePath,
    sourceMapBasis: SOURCE_MAP_DIGEST_BASIS,
    sourceMapDigest: digest(value.sourceMapDigest, ctx, `${location}.sourceMapDigest`),
    snapshotBasis: DIRECTORY_SNAPSHOT_BASIS,
    snapshotDigest: digest(value.snapshotDigest, ctx, `${location}.snapshotDigest`),
    sourceBasis: DIRECTORY_FILE_BYTES_BASIS,
    sourceState: value.sourceState,
    sourceDigest,
    sourceCanonicalBasis: expectedBasis,
    sourceCanonicalDigest,
    canonicalBasis: expectedBasis,
    canonicalState: value.canonicalState,
    canonicalDigest,
    resolution: value.resolution,
    toolVersion: text(value.toolVersion, ctx, `${location}.toolVersion`),
  };
}

function parseSource(value: unknown, recordType: "asset" | "companion", ctx: DiagnosticContext, location: string): ProvenanceSourceCheckpointV3 {
  const source = object(value, ctx, location);
  if (source.kind === "archive") return parseArchive(source, recordType, ctx, location);
  if (source.kind === "directory") return parseDirectory(source, recordType, ctx, location);
  fail(ctx, "PROVENANCE_INVALID_SOURCE_KIND", "Unknown provenance source kind.", `${location}.kind`);
}

function parseDocument(value: unknown, ctx: DiagnosticContext): ImportProvenanceV3 {
  const root = object(value, ctx, "provenance");
  exactKeys(root, ["kind", "schemaVersion", "records"], ctx, "provenance");
  if (root.kind !== PROVENANCE_KIND || root.schemaVersion !== PROVENANCE_SCHEMA_VERSION_V3) fail(ctx, "PROVENANCE_UNSUPPORTED_VERSION", "Unsupported provenance kind or schema version.", "provenance");
  if (!Array.isArray(root.records)) fail(ctx, "PROVENANCE_INVALID_TYPE", "Provenance records must be an array.", "records");
  const records: ProvenanceRecordV3[] = root.records.map((item, index) => {
    const location = `records[${index}]`;
    const record = object(item, ctx, location);
    if (record.type === "asset") {
      exactKeys(record, ["type", "assetId", "canonicalPath", "source", "migration", "normalizationPolicy"], ctx, location);
      const assetId = text(record.assetId, ctx, `${location}.assetId`);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(assetId) || record.canonicalPath !== `.tfsb/assets/${assetId}.toml`) fail(ctx, "PROVENANCE_PATH_MISMATCH", "Asset id and canonical path disagree.", `${location}.canonicalPath`);
      const fields = parseV2AssetFields(record.migration, record.normalizationPolicy);
      return { type: "asset", assetId, canonicalPath: record.canonicalPath, source: record.source === null ? null : parseSource(record.source, "asset", ctx, `${location}.source`), ...fields };
    }
    if (record.type === "companion") {
      exactKeys(record, ["type", "canonicalPath", "source"], ctx, location);
      const canonicalPath = text(record.canonicalPath, ctx, `${location}.canonicalPath`);
      if (!/^\.tfsb\/companions\/[^/]+$/.test(canonicalPath)) fail(ctx, "PROVENANCE_INVALID_PATH", "Companion path is outside the canonical tree.", `${location}.canonicalPath`);
      return { type: "companion", canonicalPath, source: parseSource(record.source, "companion", ctx, `${location}.source`) };
    }
    fail(ctx, "PROVENANCE_INVALID_RECORD", "Unknown provenance record type.", `${location}.type`);
  });
  const identities = new Set<string>();
  for (const record of records) {
    const identity = record.type === "asset" ? `asset:${record.assetId}` : `companion:${record.canonicalPath.toLowerCase()}`;
    if (identities.has(identity)) fail(ctx, "PROVENANCE_DUPLICATE_RECORD", "Duplicate provenance record identity.", record.canonicalPath);
    identities.add(identity);
  }
  return { kind: PROVENANCE_KIND, schemaVersion: PROVENANCE_SCHEMA_VERSION_V3, records };
}

function sortRecords(records: readonly ProvenanceRecordV3[]): ProvenanceRecordV3[] {
  const assets = records.filter((record): record is AssetProvenanceRecordV3 => record.type === "asset").sort((left, right) => compareUtf8(left.assetId, right.assetId));
  const companions = records.filter((record): record is CompanionProvenanceRecordV3 => record.type === "companion").sort((left, right) => compareUtf8(left.canonicalPath, right.canonicalPath));
  return [...assets, ...companions];
}

/** Explicitly lift a validated schema-2 document into the schema-3 source union. */
export function liftImportProvenanceV2ToV3(value: ImportProvenanceV2): ImportProvenanceV3 {
  const records: ProvenanceRecordV3[] = value.records.map((record) => {
    if (record.type === "asset") {
      return {
        type: "asset",
        assetId: record.assetId,
        canonicalPath: record.canonicalPath,
        source: record.archive === null ? null : { kind: "archive", ...record.archive },
        migration: record.migration,
        normalizationPolicy: record.normalizationPolicy,
      };
    }
    return {
      type: "companion",
      canonicalPath: record.canonicalPath,
      source: { kind: "archive", ...record.archive },
    };
  });
  return parseDocument({ kind: PROVENANCE_KIND, schemaVersion: PROVENANCE_SCHEMA_VERSION_V3, records: sortRecords(records) }, context());
}

export function parseImportProvenanceV3(textValue: string, source?: string): Result<ImportProvenanceV3> {
  const ctx = context(source);
  try { return ok(parseDocument(JSON.parse(textValue) as unknown, ctx)); }
  catch (error) { return fromCaught(error, ctx, "PROVENANCE_INVALID_JSON", "Provenance JSON is invalid.", (caught) => caught instanceof SyntaxError); }
}

export function serializeImportProvenanceV3(value: ImportProvenanceV3): string {
  const parsed = parseDocument(value, context());
  return `${JSON.stringify({ kind: PROVENANCE_KIND, schemaVersion: PROVENANCE_SCHEMA_VERSION_V3, records: sortRecords(parsed.records) }, null, 2)}\n`;
}

export function unwrapProvenanceV3(result: Result<ImportProvenanceV3>): ImportProvenanceV3 {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Provenance diagnostics were unexpectedly empty.");
  throw new DiagnosticError(first);
}
