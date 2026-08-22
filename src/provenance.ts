import { isAllowedCompanionFilename } from "./archive.js";
import { ASSET_DIGEST_BASIS, type Sha256Digest } from "./digests.js";
import { DiagnosticError, fail, fromCaught, ok, type DiagnosticContext } from "./diagnostics.js";
import type { Result } from "./types.js";

export const PROVENANCE_KIND = "tfsb-import-provenance" as const;
export const PROVENANCE_SCHEMA_VERSION = 1 as const;

export type ProvenanceResolution = "aligned" | "canonical";
export type CanonicalState = "present" | "absent";

interface ProvenanceRecordBaseV1 {
  readonly canonicalPath: string;
  readonly archiveDigest: Sha256Digest;
  readonly entryName: string;
  readonly entryDigest: Sha256Digest;
  readonly canonicalState: CanonicalState;
  readonly resolution: ProvenanceResolution;
  readonly toolVersion: string;
}

export interface AssetProvenanceRecordV1 extends ProvenanceRecordBaseV1 {
  readonly type: "asset";
  readonly assetId: string;
  readonly digestBasis: typeof ASSET_DIGEST_BASIS;
  readonly archiveModelDigest: Sha256Digest;
  readonly canonicalModelDigest?: Sha256Digest;
}

export interface CompanionProvenanceRecordV1 extends ProvenanceRecordBaseV1 {
  readonly type: "companion";
  readonly archiveByteDigest: Sha256Digest;
  readonly canonicalByteDigest?: Sha256Digest;
}

export type ProvenanceRecordV1 = AssetProvenanceRecordV1 | CompanionProvenanceRecordV1;

export interface ImportProvenanceV1 {
  readonly kind: typeof PROVENANCE_KIND;
  readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  readonly records: readonly ProvenanceRecordV1[];
}

const TOP_KEYS = ["kind", "schemaVersion", "records"] as const;
const ASSET_KEYS = [
  "type", "assetId", "canonicalPath", "archiveDigest", "entryName", "entryDigest",
  "digestBasis", "archiveModelDigest", "canonicalState", "canonicalModelDigest",
  "resolution", "toolVersion",
] as const;
const COMPANION_KEYS = [
  "type", "canonicalPath", "archiveDigest", "entryName", "entryDigest",
  "archiveByteDigest", "canonicalState", "canonicalByteDigest", "resolution", "toolVersion",
] as const;

function context(source?: string): DiagnosticContext {
  return { operation: "reconcile", domain: "provenance", ...(source === undefined ? {} : { source }) };
}

function record(value: unknown, ctx: DiagnosticContext, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ctx, "PROVENANCE_INVALID_TYPE", "Provenance value must be an object.", location);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  ctx: DiagnosticContext,
  location: string,
): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  if (unknown !== undefined) {
    fail(ctx, "PROVENANCE_UNKNOWN_FIELD", `Unknown provenance field '${unknown}'.`, `${location}.${unknown}`);
  }
}

function string(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") fail(ctx, "PROVENANCE_INVALID_TYPE", "Expected a string.", location);
  return value;
}

function digest(value: unknown, ctx: DiagnosticContext, location: string): Sha256Digest {
  const text = string(value, ctx, location);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) {
    fail(ctx, "PROVENANCE_INVALID_DIGEST", "Expected a lowercase sha256 digest.", location);
  }
  return text as Sha256Digest;
}

function normalizedEntryName(value: unknown, ctx: DiagnosticContext, location: string): string {
  const name = string(value, ctx, location);
  const segments = name.split("/");
  if (
    name === "" || name !== name.normalize("NFC") || name.includes("\\") || name.includes("\0") ||
    name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.endsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(ctx, "PROVENANCE_INVALID_ENTRY", "Archive entry name is not normalized and portable.", location);
  }
  return name;
}

function assetId(value: unknown, ctx: DiagnosticContext, location: string): string {
  const id = string(value, ctx, location);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    fail(ctx, "PROVENANCE_INVALID_ASSET_ID", "Asset id must be lowercase kebab-case.", location);
  }
  return id;
}

function state(value: unknown, ctx: DiagnosticContext, location: string): CanonicalState {
  if (value !== "present" && value !== "absent") {
    fail(ctx, "PROVENANCE_INVALID_STATE", "Canonical state must be present or absent.", location);
  }
  return value;
}

function resolution(value: unknown, ctx: DiagnosticContext, location: string): ProvenanceResolution {
  if (value !== "aligned" && value !== "canonical") {
    fail(ctx, "PROVENANCE_INVALID_RESOLUTION", "Resolution must be aligned or canonical.", location);
  }
  return value;
}

function validateCheckpoint(
  canonicalState: CanonicalState,
  canonicalDigest: Sha256Digest | undefined,
  archiveDigest: Sha256Digest,
  selectedResolution: ProvenanceResolution,
  ctx: DiagnosticContext,
  location: string,
): void {
  if ((canonicalState === "present") !== (canonicalDigest !== undefined)) {
    fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Canonical presence and digest disagree.", location);
  }
  if (selectedResolution === "aligned" && (canonicalDigest === undefined || canonicalDigest !== archiveDigest)) {
    fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Aligned checkpoints must be present and equal.", location);
  }
  if (selectedResolution === "canonical" && canonicalDigest !== undefined && canonicalDigest === archiveDigest) {
    fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Canonical ownership requires divergence or accepted absence.", location);
  }
}

function parseAsset(value: Record<string, unknown>, ctx: DiagnosticContext, location: string): AssetProvenanceRecordV1 {
  exactKeys(value, ASSET_KEYS, ctx, location);
  const id = assetId(value.assetId, ctx, `${location}.assetId`);
  const canonicalPath = string(value.canonicalPath, ctx, `${location}.canonicalPath`);
  if (canonicalPath !== `.tfsb/assets/${id}.toml`) {
    fail(ctx, "PROVENANCE_PATH_MISMATCH", "Asset id and canonical path disagree.", `${location}.canonicalPath`);
  }
  if (value.digestBasis !== ASSET_DIGEST_BASIS) {
    fail(ctx, "PROVENANCE_UNSUPPORTED_DIGEST_BASIS", "Unsupported asset digest basis.", `${location}.digestBasis`);
  }
  const archiveModelDigest = digest(value.archiveModelDigest, ctx, `${location}.archiveModelDigest`);
  const canonicalState = state(value.canonicalState, ctx, `${location}.canonicalState`);
  const canonicalModelDigest = value.canonicalModelDigest === undefined
    ? undefined
    : digest(value.canonicalModelDigest, ctx, `${location}.canonicalModelDigest`);
  const selectedResolution = resolution(value.resolution, ctx, `${location}.resolution`);
  validateCheckpoint(canonicalState, canonicalModelDigest, archiveModelDigest, selectedResolution, ctx, location);
  const toolVersion = string(value.toolVersion, ctx, `${location}.toolVersion`);
  if (toolVersion === "") fail(ctx, "PROVENANCE_INVALID_VERSION", "Tool version cannot be empty.", `${location}.toolVersion`);
  return {
    type: "asset", assetId: id, canonicalPath,
    archiveDigest: digest(value.archiveDigest, ctx, `${location}.archiveDigest`),
    entryName: normalizedEntryName(value.entryName, ctx, `${location}.entryName`),
    entryDigest: digest(value.entryDigest, ctx, `${location}.entryDigest`),
    digestBasis: ASSET_DIGEST_BASIS, archiveModelDigest, canonicalState,
    ...(canonicalModelDigest === undefined ? {} : { canonicalModelDigest }),
    resolution: selectedResolution, toolVersion,
  };
}

function parseCompanion(value: Record<string, unknown>, ctx: DiagnosticContext, location: string): CompanionProvenanceRecordV1 {
  exactKeys(value, COMPANION_KEYS, ctx, location);
  const canonicalPath = string(value.canonicalPath, ctx, `${location}.canonicalPath`);
  const match = /^\.tfsb\/companions\/([^/]+)$/.exec(canonicalPath);
  if (
    match?.[1] === undefined || canonicalPath !== canonicalPath.normalize("NFC") ||
    match[1].includes("\\") || match[1].includes("\0") || match[1] === "." || match[1] === ".." ||
    !isAllowedCompanionFilename(match[1])
  ) {
    fail(ctx, "PROVENANCE_INVALID_PATH", "Companion path is outside the canonical allowlist.", `${location}.canonicalPath`);
  }
  const entryName = normalizedEntryName(value.entryName, ctx, `${location}.entryName`);
  const entryDigest = digest(value.entryDigest, ctx, `${location}.entryDigest`);
  const archiveByteDigest = digest(value.archiveByteDigest, ctx, `${location}.archiveByteDigest`);
  if (entryDigest !== archiveByteDigest) {
    fail(ctx, "PROVENANCE_IMPOSSIBLE_STATE", "Companion entry and archive byte digests must agree.", location);
  }
  const canonicalState = state(value.canonicalState, ctx, `${location}.canonicalState`);
  const canonicalByteDigest = value.canonicalByteDigest === undefined
    ? undefined
    : digest(value.canonicalByteDigest, ctx, `${location}.canonicalByteDigest`);
  const selectedResolution = resolution(value.resolution, ctx, `${location}.resolution`);
  validateCheckpoint(canonicalState, canonicalByteDigest, archiveByteDigest, selectedResolution, ctx, location);
  const toolVersion = string(value.toolVersion, ctx, `${location}.toolVersion`);
  if (toolVersion === "") fail(ctx, "PROVENANCE_INVALID_VERSION", "Tool version cannot be empty.", `${location}.toolVersion`);
  return {
    type: "companion", canonicalPath,
    archiveDigest: digest(value.archiveDigest, ctx, `${location}.archiveDigest`),
    entryName, entryDigest, archiveByteDigest, canonicalState,
    ...(canonicalByteDigest === undefined ? {} : { canonicalByteDigest }),
    resolution: selectedResolution, toolVersion,
  };
}

function parseDocument(value: unknown, ctx: DiagnosticContext): ImportProvenanceV1 {
  const root = record(value, ctx, "provenance");
  exactKeys(root, TOP_KEYS, ctx, "provenance");
  if (root.kind !== PROVENANCE_KIND || root.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    fail(ctx, "PROVENANCE_UNSUPPORTED_VERSION", "Unsupported provenance kind or schema version.", "provenance");
  }
  if (!Array.isArray(root.records)) fail(ctx, "PROVENANCE_INVALID_TYPE", "Provenance records must be an array.", "records");
  const records = root.records.map((item, index) => {
    const valueRecord = record(item, ctx, `records[${index}]`);
    if (valueRecord.type === "asset") return parseAsset(valueRecord, ctx, `records[${index}]`);
    if (valueRecord.type === "companion") return parseCompanion(valueRecord, ctx, `records[${index}]`);
    fail(ctx, "PROVENANCE_INVALID_RECORD", "Unknown provenance record type.", `records[${index}].type`);
  });
  const identities = new Set<string>();
  const paths = new Set<string>();
  const entries = new Set<string>();
  for (const item of records) {
    const identity = item.type === "asset" ? `asset:${item.assetId}` : `companion:${item.canonicalPath}`;
    const portablePath = item.canonicalPath.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    const portableEntry = item.entryName.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    if (identities.has(identity) || paths.has(portablePath) || entries.has(portableEntry)) {
      fail(ctx, "PROVENANCE_DUPLICATE_RECORD", "Duplicate or conflicting provenance record identity.", item.canonicalPath);
    }
    identities.add(identity);
    paths.add(portablePath);
    entries.add(portableEntry);
  }
  return { kind: PROVENANCE_KIND, schemaVersion: PROVENANCE_SCHEMA_VERSION, records };
}

export function parseImportProvenance(text: string, source?: string): Result<ImportProvenanceV1> {
  const ctx = context(source);
  try {
    return ok(parseDocument(JSON.parse(text) as unknown, ctx));
  } catch (error) {
    return fromCaught(error, ctx, "PROVENANCE_INVALID_JSON", "Provenance JSON is invalid.", (caught) => caught instanceof SyntaxError);
  }
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function orderedRecord(item: ProvenanceRecordV1): Record<string, unknown> {
  if (item.type === "asset") {
    return {
      type: item.type, assetId: item.assetId, canonicalPath: item.canonicalPath,
      archiveDigest: item.archiveDigest, entryName: item.entryName, entryDigest: item.entryDigest,
      digestBasis: item.digestBasis, archiveModelDigest: item.archiveModelDigest,
      canonicalState: item.canonicalState,
      ...(item.canonicalModelDigest === undefined ? {} : { canonicalModelDigest: item.canonicalModelDigest }),
      resolution: item.resolution, toolVersion: item.toolVersion,
    };
  }
  return {
    type: item.type, canonicalPath: item.canonicalPath, archiveDigest: item.archiveDigest,
    entryName: item.entryName, entryDigest: item.entryDigest, archiveByteDigest: item.archiveByteDigest,
    canonicalState: item.canonicalState,
    ...(item.canonicalByteDigest === undefined ? {} : { canonicalByteDigest: item.canonicalByteDigest }),
    resolution: item.resolution, toolVersion: item.toolVersion,
  };
}

export function serializeImportProvenance(value: ImportProvenanceV1): string {
  const parsed = parseDocument(value, context());
  const assets = parsed.records.filter((item): item is AssetProvenanceRecordV1 => item.type === "asset")
    .sort((left, right) => compareUtf8(left.assetId, right.assetId));
  const companions = parsed.records.filter((item): item is CompanionProvenanceRecordV1 => item.type === "companion")
    .sort((left, right) => compareUtf8(left.canonicalPath, right.canonicalPath));
  return `${JSON.stringify({ kind: PROVENANCE_KIND, schemaVersion: PROVENANCE_SCHEMA_VERSION, records: [...assets, ...companions].map(orderedRecord) }, null, 2)}\n`;
}

export function unwrapProvenance(result: Result<ImportProvenanceV1>): ImportProvenanceV1 {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Provenance diagnostics were unexpectedly empty.");
  throw new DiagnosticError(first);
}
