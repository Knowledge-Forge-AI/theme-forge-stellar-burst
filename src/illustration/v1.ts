import { createHash } from "node:crypto";
import { hasIllustrationCredentialToken, isPublicIllustrationProviderToken } from "./privacy.js";

import { parseDuplicateFreeJson } from "../brand/consumer-lock.js";
import { canonicalJson } from "../service-protocol/canonical-json.js";
import type { Sha256Digest } from "../digests.js";

/** The source-only raster illustration metadata contract. */
export const ILLUSTRATION_SCHEMA_ID = "tfsb.raster-illustration" as const;
export const ILLUSTRATION_SCHEMA_VERSION = 1 as const;
export const ILLUSTRATION_DIGEST_BASIS = "tfsb.raster-illustration-v1\n" as const;

export const ILLUSTRATION_LIMITS = Object.freeze({
  recordBytes: 1_048_576,
  idBytes: 128,
  tokenBytes: 128,
  characters: 32,
  references: 64,
  exportRecipes: 32,
  revision: 1_000_000,
  imageBytes: 32 * 1_048_576,
  dimension: 16_384,
  pixels: 16_777_216,
  wireDepth: 32,
});

export type IllustrationDigest = Sha256Digest;
export type IllustrationOperation = "import" | "generate" | "edit";
export type RasterIllustrationMime = "image/png" | "image/webp";
export type RasterIllustrationAlpha = "opaque" | "straight" | "premultiplied" | "unknown";

export interface IllustrationCharacterRefV1 {
  readonly id: string;
  readonly revision: number;
}

export interface IllustrationStyleRefV1 {
  readonly id: string;
  readonly revision: number;
}

export interface RasterIllustrationDimensionsV1 {
  readonly width: number;
  readonly height: number;
}

export interface RasterIllustrationSourceV1 {
  readonly sha256: IllustrationDigest;
  readonly mime: RasterIllustrationMime;
  readonly byteLength: number;
  readonly dimensions: RasterIllustrationDimensionsV1;
  readonly alpha: RasterIllustrationAlpha;
}

export interface RasterIllustrationReferenceV1 {
  readonly id: string;
  readonly sha256: IllustrationDigest;
}

export interface RasterIllustrationLineageV1 {
  readonly parentDigest: IllustrationDigest | null;
}

export interface RasterIllustrationExportRecipeV1 {
  readonly id: string;
  readonly recipeSha256: IllustrationDigest;
  readonly mime: RasterIllustrationMime;
  readonly width: number;
  readonly height: number;
  readonly alpha: RasterIllustrationAlpha;
}

export interface RasterIllustrationRecordWithoutDigestV1 {
  readonly schema: typeof ILLUSTRATION_SCHEMA_ID;
  readonly schemaVersion: typeof ILLUSTRATION_SCHEMA_VERSION;
  readonly illustrationId: string;
  readonly revision: number;
  readonly operation: IllustrationOperation;
  readonly characters: readonly IllustrationCharacterRefV1[];
  readonly style: IllustrationStyleRefV1;
  /** Provider/model are observed facts, never an inferred generation claim. */
  readonly provider: string | null;
  readonly model: string | null;
  readonly source: RasterIllustrationSourceV1;
  readonly references: readonly RasterIllustrationReferenceV1[];
  readonly lineage: RasterIllustrationLineageV1;
  readonly exportRecipes: readonly RasterIllustrationExportRecipeV1[];
}

export interface RasterIllustrationRecordV1 extends RasterIllustrationRecordWithoutDigestV1 {
  readonly digest: IllustrationDigest;
}

type RecordValue = Record<string, unknown>;
type BaseRecord = RasterIllustrationRecordWithoutDigestV1;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PUBLIC_ID = /^[a-z][a-z0-9]*(?:[-._][a-z0-9]+)*$/u;
// Provider/model observations are deliberately token-like. In particular,
// paths, URLs, prompts and shell fragments cannot be carried in this record.
const MIME_TYPES = ["image/png", "image/webp"] as const;
const ALPHA_MODES = ["opaque", "straight", "premultiplied", "unknown"] as const;
const OPERATIONS = ["import", "generate", "edit"] as const;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class IllustrationValidationError extends TypeError {
  readonly code = "ILLUSTRATION_INVALID" as const;

  constructor(message = "Raster illustration metadata is invalid.") {
    super(message);
    this.name = "IllustrationValidationError";
  }
}

function invalid(path: string, reason = "is invalid"): never {
  // Keep rejected values out of diagnostics. Paths here are contract-owned
  // field labels, not caller-provided strings.
  throw new IllustrationValidationError(`${path} ${reason}.`);
}

function ownValue(record: RecordValue, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid(path, "must be a data field");
  return descriptor.value;
}

function plainRecord(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  const record = value as RecordValue;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "must be a plain object");
  if (Object.getOwnPropertySymbols(record).length !== 0) invalid(path, "contains unsupported keys");
  for (const key of Object.getOwnPropertyNames(record)) {
    if (RESERVED_KEYS.has(key)) invalid(path, "contains unsupported keys");
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid(path, "contains unsupported fields");
  }
  return record;
}

function exact(record: RecordValue, required: readonly string[], optional: readonly string[], path: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.getOwnPropertyNames(record)) if (!allowed.has(key)) invalid(path, "contains an unknown field");
  for (const key of required) if (!Object.hasOwn(record, key)) invalid(path, "is missing a required field");
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function text(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || bytes(value) > maximum) invalid(path, "must be bounded text");
  if (/[\ud800-\udfff]/u.test(value) || value !== value.normalize("NFC")) invalid(path, "must be valid NFC text");
  if (/[\u0000-\u001f\u007f]/u.test(value)) invalid(path, "contains a control character");
  return value;
}

function identifier(value: unknown, path: string): string {
  const result = text(value, path, ILLUSTRATION_LIMITS.idBytes);
  if (!PUBLIC_ID.test(result) || hasIllustrationCredentialToken(result)) invalid(path, "is not a public identifier");
  return result;
}

function observedToken(value: unknown, path: string): string | null {
  if (value === null) return null;
  const result = text(value, path, ILLUSTRATION_LIMITS.tokenBytes);
  if (!isPublicIllustrationProviderToken(result)) invalid(path, "is not a public provider/model token");
  return result;
}

function digest(value: unknown, path: string): IllustrationDigest {
  if (typeof value !== "string" || !DIGEST.test(value)) invalid(path, "is not a SHA-256 digest");
  return value as IllustrationDigest;
}

function nullableDigest(value: unknown, path: string): IllustrationDigest | null {
  return value === null ? null : digest(value, path);
}

function enumeration<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid(path, "has an unsupported value");
  return value as T;
}

function safeInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) invalid(path, "must be a bounded safe integer");
  return value;
}

function arrayValues(value: unknown, path: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid(path, "has an invalid item count");
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid(path, "contains unsupported keys");
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)) invalid(path, "contains unsupported fields");
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid(`${path}[${index}]`, "must be a data field");
    result.push(descriptor.value);
  }
  return result;
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortedUnique(values: readonly string[], path: string): void {
  for (let index = 1; index < values.length; index += 1) if (utf8Compare(values[index - 1]!, values[index]!) >= 0) invalid(path, "must be UTF-8 sorted and unique");
}

function validateCharacter(value: unknown, path: string): IllustrationCharacterRefV1 {
  const record = plainRecord(value, path); exact(record, ["id", "revision"], [], path);
  return Object.freeze({ id: identifier(ownValue(record, "id", `${path}.id`), `${path}.id`), revision: safeInteger(ownValue(record, "revision", `${path}.revision`), `${path}.revision`, 1, ILLUSTRATION_LIMITS.revision) });
}

function validateStyle(value: unknown, path: string): IllustrationStyleRefV1 {
  const record = plainRecord(value, path); exact(record, ["id", "revision"], [], path);
  return Object.freeze({ id: identifier(ownValue(record, "id", `${path}.id`), `${path}.id`), revision: safeInteger(ownValue(record, "revision", `${path}.revision`), `${path}.revision`, 1, ILLUSTRATION_LIMITS.revision) });
}

function validateDimensions(value: unknown, path: string): RasterIllustrationDimensionsV1 {
  const record = plainRecord(value, path); exact(record, ["width", "height"], [], path);
  const width = safeInteger(ownValue(record, "width", `${path}.width`), `${path}.width`, 1, ILLUSTRATION_LIMITS.dimension);
  const height = safeInteger(ownValue(record, "height", `${path}.height`), `${path}.height`, 1, ILLUSTRATION_LIMITS.dimension);
  if (width * height > ILLUSTRATION_LIMITS.pixels) invalid(path, "exceeds the pixel limit");
  return Object.freeze({ width, height });
}

function validateSource(value: unknown): RasterIllustrationSourceV1 {
  const path = "source";
  const record = plainRecord(value, path); exact(record, ["sha256", "mime", "byteLength", "dimensions", "alpha"], [], path);
  const byteLength = safeInteger(ownValue(record, "byteLength", `${path}.byteLength`), `${path}.byteLength`, 1, ILLUSTRATION_LIMITS.imageBytes);
  return Object.freeze({
    sha256: digest(ownValue(record, "sha256", `${path}.sha256`), `${path}.sha256`),
    mime: enumeration(ownValue(record, "mime", `${path}.mime`), MIME_TYPES, `${path}.mime`),
    byteLength,
    dimensions: validateDimensions(ownValue(record, "dimensions", `${path}.dimensions`), `${path}.dimensions`),
    alpha: enumeration(ownValue(record, "alpha", `${path}.alpha`), ALPHA_MODES, `${path}.alpha`),
  });
}

function validateReference(value: unknown, index: number): RasterIllustrationReferenceV1 {
  const path = `references[${index}]`;
  const record = plainRecord(value, path); exact(record, ["id", "sha256"], [], path);
  return Object.freeze({ id: identifier(ownValue(record, "id", `${path}.id`), `${path}.id`), sha256: digest(ownValue(record, "sha256", `${path}.sha256`), `${path}.sha256`) });
}

function validateLineage(value: unknown): RasterIllustrationLineageV1 {
  const path = "lineage";
  const record = plainRecord(value, path); exact(record, ["parentDigest"], [], path);
  return Object.freeze({ parentDigest: nullableDigest(ownValue(record, "parentDigest", `${path}.parentDigest`), `${path}.parentDigest`) });
}

function validateExportRecipe(value: unknown, index: number): RasterIllustrationExportRecipeV1 {
  const path = `exportRecipes[${index}]`;
  const record = plainRecord(value, path); exact(record, ["id", "recipeSha256", "mime", "width", "height", "alpha"], [], path);
  const width = safeInteger(ownValue(record, "width", `${path}.width`), `${path}.width`, 1, ILLUSTRATION_LIMITS.dimension);
  const height = safeInteger(ownValue(record, "height", `${path}.height`), `${path}.height`, 1, ILLUSTRATION_LIMITS.dimension);
  if (width * height > ILLUSTRATION_LIMITS.pixels) invalid(path, "exceeds the pixel limit");
  return Object.freeze({
    id: identifier(ownValue(record, "id", `${path}.id`), `${path}.id`),
    recipeSha256: digest(ownValue(record, "recipeSha256", `${path}.recipeSha256`), `${path}.recipeSha256`),
    mime: enumeration(ownValue(record, "mime", `${path}.mime`), MIME_TYPES, `${path}.mime`),
    width,
    height,
    alpha: enumeration(ownValue(record, "alpha", `${path}.alpha`), ALPHA_MODES, `${path}.alpha`),
  });
}

function normalizeRecord(value: unknown, requireDigest: boolean): { readonly base: BaseRecord; readonly digest?: IllustrationDigest } {
  const path = "illustration";
  const record = plainRecord(value, path);
  const required = ["schema", "schemaVersion", "illustrationId", "revision", "operation", "characters", "style", "provider", "model", "source", "references", "lineage", "exportRecipes"];
  exact(record, requireDigest ? [...required, "digest"] : required, requireDigest ? [] : ["digest"], path);
  if (ownValue(record, "schema", "schema") !== ILLUSTRATION_SCHEMA_ID) invalid("schema", "has an unsupported identifier");
  if (ownValue(record, "schemaVersion", "schemaVersion") !== ILLUSTRATION_SCHEMA_VERSION) invalid("schemaVersion", "has an unsupported version");

  const illustrationId = identifier(ownValue(record, "illustrationId", "illustrationId"), "illustrationId");
  const revision = safeInteger(ownValue(record, "revision", "revision"), "revision", 1, ILLUSTRATION_LIMITS.revision);
  const operation = enumeration(ownValue(record, "operation", "operation"), OPERATIONS, "operation");
  const characters = arrayValues(ownValue(record, "characters", "characters"), "characters", 0, ILLUSTRATION_LIMITS.characters).map((entry, index) => validateCharacter(entry, `characters[${index}]`));
  sortedUnique(characters.map((entry) => entry.id), "characters");
  const style = validateStyle(ownValue(record, "style", "style"), "style");
  const provider = observedToken(ownValue(record, "provider", "provider"), "provider");
  const model = observedToken(ownValue(record, "model", "model"), "model");
  const source = validateSource(ownValue(record, "source", "source"));
  const references = arrayValues(ownValue(record, "references", "references"), "references", 0, ILLUSTRATION_LIMITS.references).map((entry, index) => validateReference(entry, index));
  sortedUnique(references.map((entry) => entry.id), "references");
  const lineage = validateLineage(ownValue(record, "lineage", "lineage"));
  const exportRecipes = arrayValues(ownValue(record, "exportRecipes", "exportRecipes"), "exportRecipes", 0, ILLUSTRATION_LIMITS.exportRecipes).map((entry, index) => validateExportRecipe(entry, index));
  sortedUnique(exportRecipes.map((entry) => entry.id), "exportRecipes");

  if (operation === "edit" && lineage.parentDigest === null) invalid("lineage.parentDigest", "is required for edit records");
  if (operation !== "edit" && lineage.parentDigest !== null) invalid("lineage.parentDigest", "is only allowed for edit records");

  const base: BaseRecord = Object.freeze({ schema: ILLUSTRATION_SCHEMA_ID, schemaVersion: ILLUSTRATION_SCHEMA_VERSION, illustrationId, revision, operation, characters: Object.freeze(characters), style, provider, model, source, references: Object.freeze(references), lineage, exportRecipes: Object.freeze(exportRecipes) });
  const suppliedDigest = requireDigest && Object.hasOwn(record, "digest") ? digest(ownValue(record, "digest", "digest"), "digest") : undefined;
  return suppliedDigest === undefined ? { base } : { base, digest: suppliedDigest };
}

function projection(value: BaseRecord): RecordValue {
  return { schema: value.schema, schemaVersion: value.schemaVersion, illustrationId: value.illustrationId, revision: value.revision, operation: value.operation, characters: value.characters, style: value.style, provider: value.provider, model: value.model, source: value.source, references: value.references, lineage: value.lineage, exportRecipes: value.exportRecipes };
}

function compactCanonical(value: unknown): string {
  return canonicalJson(value);
}

function prettyCanonical(value: unknown): string {
  const parsed = JSON.parse(compactCanonical(value)) as unknown;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function computeRasterIllustrationDigest(value: unknown): IllustrationDigest {
  const normalized = normalizeRecord(value, false);
  const preimage = `${ILLUSTRATION_DIGEST_BASIS}${compactCanonical(projection(normalized.base))}`;
  return `sha256:${createHash("sha256").update(preimage, "utf8").digest("hex")}` as IllustrationDigest;
}

export function validateRasterIllustrationRecord(value: unknown): RasterIllustrationRecordV1 {
  const normalized = normalizeRecord(value, true);
  if (normalized.base.lineage.parentDigest !== null && normalized.base.lineage.parentDigest === normalized.digest) invalid("lineage.parentDigest", "must not point to the record itself");
  if (normalized.digest !== computeRasterIllustrationDigest(normalized.base)) invalid("digest", "does not match the canonical record");
  return Object.freeze({ ...normalized.base, digest: normalized.digest });
}

export function canonicalRasterIllustrationJson(value: unknown): string {
  return prettyCanonical(validateRasterIllustrationRecord(value));
}

export function serializeRasterIllustration(value: unknown): string {
  return canonicalRasterIllustrationJson(value);
}

export function createRasterIllustrationRecord(value: Omit<RasterIllustrationRecordWithoutDigestV1, "schema" | "schemaVersion">): RasterIllustrationRecordV1 {
  const base = { schema: ILLUSTRATION_SCHEMA_ID, schemaVersion: ILLUSTRATION_SCHEMA_VERSION, ...value };
  const digestValue = computeRasterIllustrationDigest(base);
  return validateRasterIllustrationRecord({ ...base, digest: digestValue });
}

function assertWireDepth(source: string): void {
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
      if (depth > ILLUSTRATION_LIMITS.wireDepth) invalid("wire", "exceeds the nesting limit");
    } else if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
    }
  }
}

export function parseRasterIllustration(source: string | Uint8Array, sourceName = "illustration.json"): RasterIllustrationRecordV1 {
  const byteLength = typeof source === "string" ? Buffer.byteLength(source, "utf8") : source.byteLength;
  if (byteLength > ILLUSTRATION_LIMITS.recordBytes) invalid("wire", "exceeds the record byte limit");
  let textValue: string;
  try {
    textValue = typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source);
  } catch {
    throw new IllustrationValidationError("Illustration metadata is not valid UTF-8.");
  }
  if (textValue.startsWith("\uFEFF")) invalid("wire", "must not contain a BOM");
  assertWireDepth(textValue);
  let parsed: unknown;
  try { parsed = parseDuplicateFreeJson(textValue, { operation: "validate", domain: "brand", source: "raster-illustration-v1" }); } catch { throw new IllustrationValidationError("Illustration metadata is not valid duplicate-free JSON."); }
  const record = validateRasterIllustrationRecord(parsed);
  if (canonicalRasterIllustrationJson(record) !== textValue) invalid("wire", "is not canonical JSON");
  void sourceName;
  return record;
}

export function isRasterIllustrationRecord(value: unknown): value is RasterIllustrationRecordV1 {
  try { validateRasterIllustrationRecord(value); return true; } catch { return false; }
}
