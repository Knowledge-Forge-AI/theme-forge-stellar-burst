import { ASSET_DIGEST_BASIS, ASSET_DIGEST_BASIS_V2, SVG_OUTPUT_DIGEST_BASIS, computeSha256, type Sha256Digest } from "./digests.js";
import { DiagnosticError, fail, fromCaught, ok, type DiagnosticContext } from "./diagnostics.js";
import { NORMALIZATION_MAP_SCHEMA_VERSION } from "./normalization-map.js";
import { NORMALIZATION_POLICY_BASIS, NORMALIZATION_POLICY_ID, NORMALIZATION_POLICY_VERSION, NORMALIZATION_TARGET_SCHEMA_VERSION, normalizationPolicyBytes, type MapSha256, type NormalizationPolicyIdentityV1 } from "./normalization-policy.js";
import { PROVENANCE_KIND, compareUtf8 } from "./provenance.js";
import type { Result } from "./types.js";

export const PROVENANCE_SCHEMA_VERSION_V2 = 2 as const;
export const ARCHIVE_DIGEST_BASIS = "tfsb-archive-bytes-v1" as const;
export const ARCHIVE_SOURCE_DIGEST_BASIS = "tfsb-archive-entry-bytes-v1" as const;
export const COMPANION_DIGEST_BASIS = "tfsb-companion-bytes-v1" as const;
export const MIGRATION_RESOLUTION = "schema_migration_accepted_divergence" as const;

export type ArchiveCanonicalBasis = typeof ASSET_DIGEST_BASIS | typeof ASSET_DIGEST_BASIS_V2 | typeof COMPANION_DIGEST_BASIS;
export type ArchiveCanonicalStateV2 = "present" | "absent";
export type ArchiveResolutionV2 = "aligned" | "canonical";

export interface ArchiveCheckpointV2 {
  readonly archiveDigestBasis: typeof ARCHIVE_DIGEST_BASIS;
  readonly archiveDigest: Sha256Digest;
  readonly entryName: string;
  readonly sourceBasis: typeof ARCHIVE_SOURCE_DIGEST_BASIS;
  readonly sourceDigest: Sha256Digest;
  readonly archiveCanonicalBasis: ArchiveCanonicalBasis;
  readonly archiveCanonicalDigest: Sha256Digest;
  readonly canonicalBasis: ArchiveCanonicalBasis;
  readonly canonicalState: ArchiveCanonicalStateV2;
  readonly canonicalDigest: Sha256Digest | null;
  readonly resolution: ArchiveResolutionV2;
  readonly toolVersion: string;
}

export interface MigrationEvidenceV2 {
  readonly fromSchemaVersion: 1;
  readonly toSchemaVersion: 2;
  readonly beforeBasis: typeof ASSET_DIGEST_BASIS;
  readonly beforeDigest: Sha256Digest;
  readonly afterBasis: typeof ASSET_DIGEST_BASIS_V2;
  readonly afterDigest: Sha256Digest;
  readonly svgBasis: typeof SVG_OUTPUT_DIGEST_BASIS;
  readonly beforeSvgDigest: Sha256Digest;
  readonly afterSvgDigest: Sha256Digest;
  readonly svgEquivalent: true;
  readonly resolution: typeof MIGRATION_RESOLUTION;
  readonly toolVersion: string;
}

export interface AssetProvenanceRecordV2 {
  readonly type: "asset";
  readonly assetId: string;
  readonly canonicalPath: string;
  readonly archive: ArchiveCheckpointV2 | null;
  readonly migration: MigrationEvidenceV2 | null;
  readonly normalizationPolicy: NormalizationPolicyIdentityV1 | null;
}

export interface CompanionProvenanceRecordV2 {
  readonly type: "companion";
  readonly canonicalPath: string;
  readonly archive: ArchiveCheckpointV2;
}

export type ProvenanceRecordV2 = AssetProvenanceRecordV2 | CompanionProvenanceRecordV2;

export interface ImportProvenanceV2 {
  readonly kind: typeof PROVENANCE_KIND;
  readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION_V2;
  readonly records: readonly ProvenanceRecordV2[];
}

function context(source?: string): DiagnosticContext { return { operation: "reconcile", domain: "provenance", ...(source === undefined ? {} : { source }) }; }
function object(value: unknown, ctx: DiagnosticContext, location: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) fail(ctx, "PROVENANCE_INVALID_TYPE", "Provenance value must be an object.", location); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], ctx: DiagnosticContext, location: string): void { const allowed = new Set(keys); const unknown = Object.keys(value).find((key) => !allowed.has(key)); if (unknown !== undefined) fail(ctx, "PROVENANCE_UNKNOWN_FIELD", `Unknown provenance field '${unknown}'.`, `${location}.${unknown}`); }
function text(value: unknown, ctx: DiagnosticContext, location: string): string { if (typeof value !== "string" || value === "") fail(ctx, "PROVENANCE_INVALID_TYPE", "Expected a non-empty string.", location); return value; }
function digest(value: unknown, ctx: DiagnosticContext, location: string): Sha256Digest { const result = text(value, ctx, location); if (!/^sha256:[0-9a-f]{64}$/.test(result)) fail(ctx, "PROVENANCE_INVALID_DIGEST", "Expected a lowercase sha256 digest.", location); return result as Sha256Digest; }
function entryName(value: unknown, ctx: DiagnosticContext, location: string): string { const result = text(value, ctx, location); const parts = result.split("/"); if (result !== result.normalize("NFC") || result.includes("\\") || result.includes("\0") || result.startsWith("/") || /^[A-Za-z]:/.test(result) || result.endsWith("/") || parts.some((part) => part === "" || part === "." || part === "..")) fail(ctx, "PROVENANCE_INVALID_ENTRY", "Archive entry name is not normalized and portable.", location); return result; }
function basis(value: unknown, allowed: readonly string[], ctx: DiagnosticContext, location: string): string { if (typeof value !== "string" || !allowed.includes(value)) fail(ctx, "PROVENANCE_UNSUPPORTED_DIGEST_BASIS", "Unsupported provenance digest basis.", location); return value; }

function parseArchive(value: unknown, ctx: DiagnosticContext, location: string): ArchiveCheckpointV2 {
  const record = object(value, ctx, location);
  exactKeys(record, ["archiveDigestBasis", "archiveDigest", "entryName", "sourceBasis", "sourceDigest", "archiveCanonicalBasis", "archiveCanonicalDigest", "canonicalBasis", "canonicalState", "canonicalDigest", "resolution", "toolVersion"], ctx, location);
  if (record.archiveDigestBasis !== ARCHIVE_DIGEST_BASIS || record.sourceBasis !== ARCHIVE_SOURCE_DIGEST_BASIS) fail(ctx, "PROVENANCE_UNSUPPORTED_DIGEST_BASIS", "Unsupported archive digest basis.", location);
  const canonicalBasis = basis(record.canonicalBasis, [ASSET_DIGEST_BASIS, ASSET_DIGEST_BASIS_V2, COMPANION_DIGEST_BASIS], ctx, `${location}.canonicalBasis`) as ArchiveCanonicalBasis;
  const archiveCanonicalBasis = basis(record.archiveCanonicalBasis, [ASSET_DIGEST_BASIS, ASSET_DIGEST_BASIS_V2, COMPANION_DIGEST_BASIS], ctx, `${location}.archiveCanonicalBasis`) as ArchiveCanonicalBasis;
  if (archiveCanonicalBasis !== canonicalBasis) fail(ctx, "PROVENANCE_UNSUPPORTED_DIGEST_BASIS", "Archive and current canonical relations must use the same digest basis.", location);
  const archiveCanonicalDigest = digest(record.archiveCanonicalDigest, ctx, `${location}.archiveCanonicalDigest`);
  if (record.canonicalState !== "present" && record.canonicalState !== "absent") fail(ctx, "PROVENANCE_INVALID_STATE", "Canonical state must be present or absent.", `${location}.canonicalState`);
  const canonicalDigest = record.canonicalDigest === null ? null : digest(record.canonicalDigest, ctx, `${location}.canonicalDigest`);
  if ((record.canonicalState === "present") !== (canonicalDigest !== null)) fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Canonical state and digest disagree.", location);
  if (record.resolution !== "aligned" && record.resolution !== "canonical") fail(ctx, "PROVENANCE_INVALID_RESOLUTION", "Resolution must be aligned or canonical.", `${location}.resolution`);
  const sourceDigest = digest(record.sourceDigest, ctx, `${location}.sourceDigest`);
  if (record.resolution === "aligned" && (canonicalDigest === null || canonicalDigest !== archiveCanonicalDigest)) fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Aligned checkpoints must be present and canonically equal.", location);
  if (record.resolution === "canonical" && canonicalDigest !== null && canonicalDigest === archiveCanonicalDigest) fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Canonical ownership requires divergence or accepted absence.", location);
  return { archiveDigestBasis: ARCHIVE_DIGEST_BASIS, archiveDigest: digest(record.archiveDigest, ctx, `${location}.archiveDigest`), entryName: entryName(record.entryName, ctx, `${location}.entryName`), sourceBasis: ARCHIVE_SOURCE_DIGEST_BASIS, sourceDigest, archiveCanonicalBasis, archiveCanonicalDigest, canonicalBasis, canonicalState: record.canonicalState, canonicalDigest, resolution: record.resolution, toolVersion: text(record.toolVersion, ctx, `${location}.toolVersion`) };
}

function parseMigration(value: unknown, ctx: DiagnosticContext, location: string): MigrationEvidenceV2 {
  const record = object(value, ctx, location);
  exactKeys(record, ["fromSchemaVersion", "toSchemaVersion", "beforeBasis", "beforeDigest", "afterBasis", "afterDigest", "svgBasis", "beforeSvgDigest", "afterSvgDigest", "svgEquivalent", "resolution", "toolVersion"], ctx, location);
  if (record.fromSchemaVersion !== 1 || record.toSchemaVersion !== 2 || record.beforeBasis !== ASSET_DIGEST_BASIS || record.afterBasis !== ASSET_DIGEST_BASIS_V2 || record.svgBasis !== SVG_OUTPUT_DIGEST_BASIS) fail(ctx, "PROVENANCE_UNSUPPORTED_DIGEST_BASIS", "Migration schema or digest basis is invalid.", location);
  if (record.svgEquivalent !== true || record.resolution !== MIGRATION_RESOLUTION) fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Migration must record exact SVG-equivalent accepted divergence.", location);
  const beforeSvgDigest = digest(record.beforeSvgDigest, ctx, `${location}.beforeSvgDigest`);
  const afterSvgDigest = digest(record.afterSvgDigest, ctx, `${location}.afterSvgDigest`);
  if (beforeSvgDigest !== afterSvgDigest) fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Equivalent migration SVG digests must match.", location);
  return { fromSchemaVersion: 1, toSchemaVersion: 2, beforeBasis: ASSET_DIGEST_BASIS, beforeDigest: digest(record.beforeDigest, ctx, `${location}.beforeDigest`), afterBasis: ASSET_DIGEST_BASIS_V2, afterDigest: digest(record.afterDigest, ctx, `${location}.afterDigest`), svgBasis: SVG_OUTPUT_DIGEST_BASIS, beforeSvgDigest, afterSvgDigest, svgEquivalent: true, resolution: MIGRATION_RESOLUTION, toolVersion: text(record.toolVersion, ctx, `${location}.toolVersion`) };
}

function parsePolicy(value: unknown, ctx: DiagnosticContext, location: string): NormalizationPolicyIdentityV1 {
  const record = object(value, ctx, location);
  exactKeys(record, ["policyBasis", "policyId", "policyVersion", "targetSchemaVersion", "mapSchemaVersion", "mapSha256", "policyDigest", "implementationVersion"], ctx, location);
  if (record.policyBasis !== NORMALIZATION_POLICY_BASIS || record.policyId !== NORMALIZATION_POLICY_ID || record.policyVersion !== NORMALIZATION_POLICY_VERSION || record.targetSchemaVersion !== NORMALIZATION_TARGET_SCHEMA_VERSION || record.mapSchemaVersion !== NORMALIZATION_MAP_SCHEMA_VERSION) fail(ctx, "PROVENANCE_UNSUPPORTED_POLICY", "Unsupported normalization policy identity.", location);
  const mapSha256: MapSha256 = record.mapSha256 === "none" ? "none" : digest(record.mapSha256, ctx, `${location}.mapSha256`);
  const policyDigest = digest(record.policyDigest, ctx, `${location}.policyDigest`);
  if (policyDigest !== computeSha256(Buffer.from(normalizationPolicyBytes(mapSha256), "ascii"))) fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Normalization policy digest does not match its identity.", location);
  return { policyBasis: NORMALIZATION_POLICY_BASIS, policyId: NORMALIZATION_POLICY_ID, policyVersion: NORMALIZATION_POLICY_VERSION, targetSchemaVersion: NORMALIZATION_TARGET_SCHEMA_VERSION, mapSchemaVersion: NORMALIZATION_MAP_SCHEMA_VERSION, mapSha256, policyDigest, implementationVersion: text(record.implementationVersion, ctx, `${location}.implementationVersion`) };
}

function parseDocument(value: unknown, ctx: DiagnosticContext): ImportProvenanceV2 {
  const root = object(value, ctx, "provenance");
  exactKeys(root, ["kind", "schemaVersion", "records"], ctx, "provenance");
  if (root.kind !== PROVENANCE_KIND || root.schemaVersion !== PROVENANCE_SCHEMA_VERSION_V2) fail(ctx, "PROVENANCE_UNSUPPORTED_VERSION", "Unsupported provenance kind or schema version.", "provenance");
  if (!Array.isArray(root.records)) fail(ctx, "PROVENANCE_INVALID_TYPE", "Provenance records must be an array.", "records");
  const records: ProvenanceRecordV2[] = root.records.map((item, index) => {
    const location = `records[${index}]`; const record = object(item, ctx, location);
    if (record.type === "asset") {
      exactKeys(record, ["type", "assetId", "canonicalPath", "archive", "migration", "normalizationPolicy"], ctx, location);
      const assetId = text(record.assetId, ctx, `${location}.assetId`);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(assetId) || record.canonicalPath !== `.tfsb/assets/${assetId}.toml`) fail(ctx, "PROVENANCE_PATH_MISMATCH", "Asset id and canonical path disagree.", `${location}.canonicalPath`);
      return { type: "asset", assetId, canonicalPath: record.canonicalPath, archive: record.archive === null ? null : parseArchive(record.archive, ctx, `${location}.archive`), migration: record.migration === null ? null : parseMigration(record.migration, ctx, `${location}.migration`), normalizationPolicy: record.normalizationPolicy === null ? null : parsePolicy(record.normalizationPolicy, ctx, `${location}.normalizationPolicy`) };
    }
    if (record.type === "companion") {
      exactKeys(record, ["type", "canonicalPath", "archive"], ctx, location);
      const canonicalPath = text(record.canonicalPath, ctx, `${location}.canonicalPath`);
      if (!/^\.tfsb\/companions\/[^/]+$/.test(canonicalPath)) fail(ctx, "PROVENANCE_INVALID_PATH", "Companion path is outside the canonical tree.", `${location}.canonicalPath`);
      const archive = parseArchive(record.archive, ctx, `${location}.archive`);
      if (archive.canonicalBasis !== COMPANION_DIGEST_BASIS) fail(ctx, "PROVENANCE_UNSUPPORTED_DIGEST_BASIS", "Companion archive relation requires the companion byte basis.", `${location}.archive.canonicalBasis`);
      return { type: "companion", canonicalPath, archive };
    }
    fail(ctx, "PROVENANCE_INVALID_RECORD", "Unknown provenance record type.", `${location}.type`);
  });
  const identities = new Set<string>();
  for (const record of records) { const identity = record.type === "asset" ? `asset:${record.assetId}` : `companion:${record.canonicalPath.toLowerCase()}`; if (identities.has(identity)) fail(ctx, "PROVENANCE_DUPLICATE_RECORD", "Duplicate provenance record identity.", record.canonicalPath); identities.add(identity); }
  return { kind: PROVENANCE_KIND, schemaVersion: PROVENANCE_SCHEMA_VERSION_V2, records };
}

export function parseImportProvenanceV2(text: string, source?: string): Result<ImportProvenanceV2> { const ctx = context(source); try { return ok(parseDocument(JSON.parse(text) as unknown, ctx)); } catch (error) { return fromCaught(error, ctx, "PROVENANCE_INVALID_JSON", "Provenance JSON is invalid.", (caught) => caught instanceof SyntaxError); } }
export function serializeImportProvenanceV2(value: ImportProvenanceV2): string { const parsed = parseDocument(value, context()); const assets = parsed.records.filter((record): record is AssetProvenanceRecordV2 => record.type === "asset").sort((a, b) => compareUtf8(a.assetId, b.assetId)); const companions = parsed.records.filter((record): record is CompanionProvenanceRecordV2 => record.type === "companion").sort((a, b) => compareUtf8(a.canonicalPath, b.canonicalPath)); return `${JSON.stringify({ kind: PROVENANCE_KIND, schemaVersion: PROVENANCE_SCHEMA_VERSION_V2, records: [...assets, ...companions] }, null, 2)}\n`; }
export function unwrapProvenanceV2(result: Result<ImportProvenanceV2>): ImportProvenanceV2 { if (result.ok) return result.value; const first = result.diagnostics[0]; if (first === undefined) throw new Error("Provenance diagnostics were unexpectedly empty."); throw new DiagnosticError(first); }
