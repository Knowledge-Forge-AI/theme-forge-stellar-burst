import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";

import { decodeStrictPng } from "../brand/raster-capability.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import { canonicalJson } from "../service-protocol/canonical-json.js";
import { downsampleArea, quantizeAreaRgb6 } from "./area-resample.js";
import { hasIllustrationCredentialToken, hasIllustrationPrivateTokenPrefix } from "./privacy.js";

/**
 * Opt-in external ImageMagick derivative capability. This module is not
 * imported by ordinary SVG builds and never selects an arbitrary executable.
 */
export const DERIVATIVE_RECIPE_SCHEMA_ID = "tfsb.raster-derivative-recipe" as const;
export const DERIVATIVE_RECIPE_SCHEMA_VERSION = 1 as const;
export const DERIVATIVE_RECIPE_DIGEST_BASIS = "tfsb.raster-derivative-recipe-v1\n" as const;
const DERIVATIVE_RECEIPT_SCHEMA = "tfsb.illustration-derivative-receipt" as const;
const DERIVATIVE_RECEIPT_SCHEMA_VERSION = 1 as const;
const DERIVATIVE_RECEIPT_DIGEST_BASIS = "tfsb.illustration-derivative-receipt-v1\n" as const;
export const MAGICK_EXECUTABLE = "magick" as const;

export const DERIVATIVE_LIMITS = Object.freeze({
  recipeBytes: 256 * 1_024,
  idBytes: 128,
  processorVersionBytes: 128,
  sourceBytes: 32 * 1_048_576,
  outputBytes: 32 * 1_048_576,
  maxDimension: 16_384,
  maxPixels: 16_777_216,
  maxProcessOutputBytes: 32 * 1_048_576,
  maxProbeOutputBytes: 256 * 1_024,
  processTimeoutMs: 15_000,
  killGraceMs: 500,
});

export type RasterDerivativeMime = "image/png" | "image/webp";
export type RasterDerivativeFilter = "Lanczos" | "Mitchell" | "Catrom" | "Box";
export type RasterDerivativeAlpha = "opaque" | "has-alpha" | "unknown";

export interface ImageMagickProcessorDescriptorV1 {
  readonly kind: "imagemagick";
  readonly executable: typeof MAGICK_EXECUTABLE;
  readonly version: string;
  /** Null because this source slice does not publish a private binary path. */
  readonly binarySha256: Sha256Digest | null;
  /** Null because delegate/library closure identity is not yet captured. */
  readonly closureSha256: Sha256Digest | null;
  readonly identityScope: "same-host-version-only";
}

export interface RasterDerivativeOutputRecipeV1 {
  readonly mime: RasterDerivativeMime;
  readonly width: number;
  readonly height: number;
  readonly fit: "contain-pad";
  readonly colorSpace: "srgb";
  readonly metadata: "stripped";
  readonly alpha: "preserve";
  readonly quality: number;
  readonly method: number;
  readonly filter: RasterDerivativeFilter;
}

export interface RasterDerivativeRecipeWithoutDigestV1 {
  readonly schema: typeof DERIVATIVE_RECIPE_SCHEMA_ID;
  readonly schemaVersion: typeof DERIVATIVE_RECIPE_SCHEMA_VERSION;
  readonly recipeId: string;
  readonly recipeRevision: number;
  readonly sourceSha256: Sha256Digest;
  readonly sourceMime: RasterDerivativeMime;
  readonly output: RasterDerivativeOutputRecipeV1;
  readonly processor: ImageMagickProcessorDescriptorV1;
}

export interface RasterDerivativeRecipeV1 extends RasterDerivativeRecipeWithoutDigestV1 {
  readonly recipeDigest: Sha256Digest;
}

export type RasterDerivativeOutputRecipeV2 = RasterDerivativeOutputRecipeV1 & {
  readonly mime: "image/webp";
  readonly chroma: "sharp-yuv";
};

type RasterDerivativeRecipeWithoutDigestV2 = Omit<RasterDerivativeRecipeWithoutDigestV1, "schemaVersion" | "output"> & {
  readonly schemaVersion: 2;
  readonly output: RasterDerivativeOutputRecipeV2;
};

export interface RasterDerivativeRecipeV2 extends RasterDerivativeRecipeWithoutDigestV2 {
  readonly recipeDigest: Sha256Digest;
}

type RasterDerivativeRecipeWithoutDigest = RasterDerivativeRecipeWithoutDigestV1 | RasterDerivativeRecipeWithoutDigestV2;
export type RasterDerivativeRecipe = RasterDerivativeRecipeV1 | RasterDerivativeRecipeV2;

export const AREA_RESAMPLE_ID = "area-srgb-alpha-weighted-v1" as const;

interface RasterDerivativeAreaRecipeWithoutDigest extends Omit<RasterDerivativeRecipeWithoutDigestV1, "schemaVersion" | "output" | "sourceMime"> {
  readonly schemaVersion: 3;
  readonly sourceMime: "image/png";
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly output: Omit<RasterDerivativeOutputRecipeV2, "filter" | "fit"> & {
    readonly fit: "fill";
    readonly resample: typeof AREA_RESAMPLE_ID;
  };
}

export interface RasterDerivativeAreaRecipe extends RasterDerivativeAreaRecipeWithoutDigest {
  readonly recipeDigest: Sha256Digest;
}

export const RGB6_ENCODING_ID = "rgb6-vp8l-v1" as const;

type RasterDerivativeRgb6RecipeWithoutDigest = Omit<RasterDerivativeAreaRecipeWithoutDigest, "schemaVersion" | "output"> & {
  readonly schemaVersion: 4;
  readonly output: RasterDerivativeAreaRecipeWithoutDigest["output"] & {
    readonly quality: 100;
    readonly method: 6;
    readonly encoding: typeof RGB6_ENCODING_ID;
  };
};

type AreaRecipeWithoutDigest = RasterDerivativeAreaRecipeWithoutDigest | RasterDerivativeRgb6RecipeWithoutDigest;
type AreaRecipe = AreaRecipeWithoutDigest & { readonly recipeDigest: Sha256Digest };

export interface RasterDerivativeOutputV1 {
  readonly sourceSha256: Sha256Digest;
  readonly recipeDigest: Sha256Digest;
  readonly processor: ImageMagickProcessorDescriptorV1;
  readonly mime: RasterDerivativeMime;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly alpha: RasterDerivativeAlpha;
  /** PNG is locally pixel-decoded; WebP is processor-decoded and dimension-verified. */
  readonly verification: "png-pixels-decoded" | "processor-decoded-dimensions";
}

export interface RasterDerivativeReceiptV1 {
  readonly schema: typeof DERIVATIVE_RECEIPT_SCHEMA;
  readonly schemaVersion: typeof DERIVATIVE_RECEIPT_SCHEMA_VERSION;
  readonly sourceSha256: Sha256Digest;
  readonly recipeDigest: Sha256Digest;
  readonly outputSha256: Sha256Digest;
  readonly byteLength: number;
  readonly mime: RasterDerivativeMime;
  readonly width: number;
  readonly height: number;
  readonly alpha: RasterDerivativeAlpha;
  readonly verification: RasterDerivativeOutputV1["verification"];
  readonly processor: Readonly<Pick<ImageMagickProcessorDescriptorV1, "identityScope">>;
  readonly receiptDigest: Sha256Digest;
}

export type DerivativeCapabilityStatus =
  | Readonly<{ available: true; processor: ImageMagickProcessorDescriptorV1 }>
  | Readonly<{ available: false; code: "DERIVATIVE_PROCESSOR_UNAVAILABLE"; reason: string }>;

export type RasterDerivativeFailureCode =
  | "INVALID_RECIPE"
  | "SOURCE_INVALID"
  | "SOURCE_CHECKSUM_MISMATCH"
  | "PROCESSOR_UNAVAILABLE"
  | "PROCESSOR_MISMATCH"
  | "PROCESS_FAILED"
  | "OUTPUT_INVALID"
  | "PROCESS_TIMEOUT"
  | "PROCESS_CANCELLED"
  | "PROCESS_OUTPUT_LIMIT";

export class RasterDerivativeError extends Error {
  readonly code: RasterDerivativeFailureCode;

  constructor(code: RasterDerivativeFailureCode, message = "Raster derivative operation failed.") {
    super(message);
    this.name = "RasterDerivativeError";
    this.code = code;
  }
}

type RecordValue = Record<string, unknown>;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[a-z][a-z0-9]*(?:[-._][a-z0-9]+)*$/u;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,127}$/u;
const FILTERS = ["Lanczos", "Mitchell", "Catrom", "Box"] as const;
const MIMES = ["image/png", "image/webp"] as const;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function invalid(message = "Raster derivative metadata is invalid."): never {
  throw new RasterDerivativeError("INVALID_RECIPE", message);
}

function own(record: RecordValue, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
  return descriptor.value;
}

function plainRecord(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as RecordValue;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(record).length > 0) invalid();
  for (const key of Object.getOwnPropertyNames(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (RESERVED_KEYS.has(key) || descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return record;
}

function exact(record: RecordValue, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.getOwnPropertyNames(record).some((key) => !allowed.has(key))) invalid();
  if (required.some((key) => !Object.hasOwn(record, key))) invalid();
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/u.test(value) || /[\ud800-\udfff]/u.test(value)) invalid();
  return value;
}

export function validateRasterDerivativeRecipeId(value: unknown): string {
  const result = text(value, DERIVATIVE_LIMITS.idBytes);
  if (!ID.test(result) || hasIllustrationPrivateTokenPrefix(result) || hasIllustrationCredentialToken(result)) invalid();
  return result;
}

function digest(value: unknown): Sha256Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) invalid();
  return value as Sha256Digest;
}

function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) invalid();
  return value as T;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) invalid();
  return value;
}

function dimensions(width: unknown, height: unknown): readonly [number, number] {
  const parsedWidth = integer(width, 1, DERIVATIVE_LIMITS.maxDimension);
  const parsedHeight = integer(height, 1, DERIVATIVE_LIMITS.maxDimension);
  if (parsedWidth * parsedHeight > DERIVATIVE_LIMITS.maxPixels) invalid();
  return [parsedWidth, parsedHeight];
}

function normalizeProcessor(value: unknown): ImageMagickProcessorDescriptorV1 {
  const record = plainRecord(value);
  exact(record, ["kind", "executable", "version", "binarySha256", "closureSha256", "identityScope"]);
  if (own(record, "kind") !== "imagemagick" || own(record, "executable") !== MAGICK_EXECUTABLE || own(record, "identityScope") !== "same-host-version-only") invalid();
  const version = text(own(record, "version"), DERIVATIVE_LIMITS.processorVersionBytes);
  if (!VERSION.test(version)) invalid();
  const binarySha256 = own(record, "binarySha256");
  const closureSha256 = own(record, "closureSha256");
  if (binarySha256 !== null && (typeof binarySha256 !== "string" || !DIGEST.test(binarySha256))) invalid();
  if (closureSha256 !== null && (typeof closureSha256 !== "string" || !DIGEST.test(closureSha256))) invalid();
  return Object.freeze({ kind: "imagemagick", executable: MAGICK_EXECUTABLE, version, binarySha256: binarySha256 === null ? null : digest(binarySha256), closureSha256: closureSha256 === null ? null : digest(closureSha256), identityScope: "same-host-version-only" });
}

function normalizeOutput(value: unknown, sharp = false): RasterDerivativeOutputRecipeV1 {
  const record = plainRecord(value);
  const fields = ["mime", "width", "height", "fit", "colorSpace", "metadata", "alpha", "quality", "method", "filter"];
  exact(record, sharp ? [...fields, "chroma"] : fields);
  const [width, height] = dimensions(own(record, "width"), own(record, "height"));
  if (own(record, "fit") !== "contain-pad" || own(record, "colorSpace") !== "srgb" || own(record, "metadata") !== "stripped" || own(record, "alpha") !== "preserve") invalid();
  return Object.freeze({ mime: enumeration(own(record, "mime"), MIMES), width, height, fit: "contain-pad", colorSpace: "srgb", metadata: "stripped", alpha: "preserve", quality: integer(own(record, "quality"), 0, 100), method: integer(own(record, "method"), 0, 6), filter: enumeration(own(record, "filter"), FILTERS) });
}

function normalizeRecipe(value: unknown, requireDigest: boolean): { readonly base: RasterDerivativeRecipeWithoutDigest; readonly recipeDigest?: Sha256Digest } {
  const record = plainRecord(value);
  const required = ["schema", "schemaVersion", "recipeId", "recipeRevision", "sourceSha256", "sourceMime", "output", "processor"];
  exact(record, requireDigest ? [...required, "recipeDigest"] : required, requireDigest ? [] : ["recipeDigest"]);
  const version = own(record, "schemaVersion");
  if (own(record, "schema") !== DERIVATIVE_RECIPE_SCHEMA_ID || (version !== 1 && version !== 2)) invalid();
  const rawOutput = own(record, "output");
  const output = normalizeOutput(rawOutput, version === 2);
  const common = {
    schema: DERIVATIVE_RECIPE_SCHEMA_ID, recipeId: validateRasterDerivativeRecipeId(own(record, "recipeId")),
    recipeRevision: integer(own(record, "recipeRevision"), 1, 1_000_000),
    sourceSha256: digest(own(record, "sourceSha256")), sourceMime: enumeration(own(record, "sourceMime"), MIMES),
    processor: normalizeProcessor(own(record, "processor")),
  };
  let base: RasterDerivativeRecipeWithoutDigest;
  if (version === 2) {
    if (output.mime !== "image/webp" || own(plainRecord(rawOutput), "chroma") !== "sharp-yuv") invalid();
    base = Object.freeze({ ...common, schemaVersion: 2, output: Object.freeze({ ...output, mime: "image/webp", chroma: "sharp-yuv" }) });
  } else {
    base = Object.freeze({ ...common, schemaVersion: 1, output });
  }
  if (Buffer.byteLength(canonicalJson(recipeProjection(base)), "utf8") > DERIVATIVE_LIMITS.recipeBytes) invalid();
  return requireDigest ? { base, recipeDigest: digest(own(record, "recipeDigest")) } : { base };
}

function recipeProjection(recipe: RasterDerivativeRecipeWithoutDigest): RecordValue {
  return { schema: recipe.schema, schemaVersion: recipe.schemaVersion, recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, sourceSha256: recipe.sourceSha256, sourceMime: recipe.sourceMime, output: recipe.output, processor: recipe.processor };
}

function recipeDigest(value: RasterDerivativeRecipeWithoutDigest): Sha256Digest {
  const basis = value.schemaVersion === 1 ? DERIVATIVE_RECIPE_DIGEST_BASIS : "tfsb.raster-derivative-recipe-v2\n";
  return computeSha256(Buffer.from(`${basis}${canonicalJson(recipeProjection(value))}`, "utf8"));
}

export function computeRasterDerivativeRecipeDigest(value: unknown): Sha256Digest {
  return recipeDigest(normalizeRecipe(value, false).base);
}

export function validateRasterDerivativeRecipe(value: unknown): RasterDerivativeRecipe {
  const normalized = normalizeRecipe(value, true);
  if (normalized.recipeDigest !== recipeDigest(normalized.base)) invalid();
  return Object.freeze({ ...normalized.base, recipeDigest: normalized.recipeDigest });
}

export function createRasterDerivativeRecipe(value: Omit<RasterDerivativeRecipeWithoutDigestV1, "schema" | "schemaVersion">): RasterDerivativeRecipeV1 {
  const base = { schema: DERIVATIVE_RECIPE_SCHEMA_ID, schemaVersion: 1, ...value };
  const recipe = validateRasterDerivativeRecipe({ ...base, recipeDigest: computeRasterDerivativeRecipeDigest(base) });
  if (recipe.schemaVersion !== 1) invalid();
  return recipe;
}

export function canonicalRasterDerivativeRecipeJson(value: unknown): string {
  const recipe = validateRasterDerivativeRecipe(value);
  return `${JSON.stringify(JSON.parse(canonicalJson(recipe)), null, 2)}\n`;
}

function normalizeAreaRecipe(value: unknown, requireDigest: boolean): AreaRecipeWithoutDigest {
  const record = plainRecord(value);
  const required = ["schema", "schemaVersion", "recipeId", "recipeRevision", "sourceSha256", "sourceMime",
    "sourceWidth", "sourceHeight", "output", "processor"];
  exact(record, requireDigest ? [...required, "recipeDigest"] : required);
  const version = own(record, "schemaVersion");
  if (own(record, "schema") !== DERIVATIVE_RECIPE_SCHEMA_ID || (version !== 3 && version !== 4)
      || own(record, "sourceMime") !== "image/png") invalid();
  const [sourceWidth, sourceHeight] = dimensions(own(record, "sourceWidth"), own(record, "sourceHeight"));
  const output = plainRecord(own(record, "output"));
  const outputKeys = ["mime", "width", "height", "fit", "colorSpace", "metadata", "alpha", "quality", "method", "chroma", "resample"];
  exact(output, version === 4 ? [...outputKeys, "encoding"] : outputKeys);
  if (version === 4 && (own(output, "encoding") !== RGB6_ENCODING_ID
      || own(output, "quality") !== 100 || own(output, "method") !== 6)) invalid();
  const [width, height] = dimensions(own(output, "width"), own(output, "height"));
  if (width > sourceWidth || height > sourceHeight
      || height !== Math.round(width * sourceHeight / sourceWidth)) invalid();
  if (own(output, "mime") !== "image/webp" || own(output, "fit") !== "fill"
      || own(output, "colorSpace") !== "srgb" || own(output, "metadata") !== "stripped"
      || own(output, "alpha") !== "preserve" || own(output, "chroma") !== "sharp-yuv"
      || own(output, "resample") !== AREA_RESAMPLE_ID) invalid();
  const baseline: RasterDerivativeAreaRecipeWithoutDigest = Object.freeze({
    schema: DERIVATIVE_RECIPE_SCHEMA_ID, schemaVersion: 3, sourceMime: "image/png", sourceWidth, sourceHeight,
    recipeId: validateRasterDerivativeRecipeId(own(record, "recipeId")),
    recipeRevision: integer(own(record, "recipeRevision"), 1, 1_000_000),
    sourceSha256: digest(own(record, "sourceSha256")), processor: normalizeProcessor(own(record, "processor")),
    output: Object.freeze({
      mime: "image/webp", width, height, fit: "fill", colorSpace: "srgb", metadata: "stripped", alpha: "preserve",
      quality: integer(own(output, "quality"), 0, 100), method: integer(own(output, "method"), 0, 6),
      chroma: "sharp-yuv", resample: AREA_RESAMPLE_ID,
    }),
  });
  const normalized: AreaRecipeWithoutDigest = version === 3 ? baseline : Object.freeze({
    ...baseline, schemaVersion: 4,
    output: Object.freeze({ ...baseline.output, quality: 100, method: 6, encoding: RGB6_ENCODING_ID }),
  });
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > DERIVATIVE_LIMITS.recipeBytes) invalid();
  return normalized;
}

function areaRecipeDigest(recipe: AreaRecipeWithoutDigest): Sha256Digest {
  return computeSha256(Buffer.from(`tfsb.raster-derivative-recipe-v${recipe.schemaVersion}\n${canonicalJson(recipe)}`, "utf8"));
}

export function validateRasterDerivativeAreaRecipe(value: unknown): RasterDerivativeAreaRecipe {
  const recipe = validateAreaRecipe(value);
  if (recipe.schemaVersion !== 3) invalid();
  return recipe;
}

function validateAreaRecipe(value: unknown): AreaRecipe {
  const recipe = normalizeAreaRecipe(value, true);
  const recipeDigest = digest(own(plainRecord(value), "recipeDigest"));
  if (recipeDigest !== areaRecipeDigest(recipe)) invalid();
  return Object.freeze({ ...recipe, recipeDigest });
}

export type CarrierDerivativeRecipe = RasterDerivativeRecipe | AreaRecipe;

export function isRgb6Recipe(recipe: CarrierDerivativeRecipe): boolean {
  return recipe.schemaVersion === 4 && recipe.output.encoding === RGB6_ENCODING_ID;
}

export function validateCarrierDerivativeRecipe(value: unknown): CarrierDerivativeRecipe {
  switch (own(plainRecord(value), "schemaVersion")) {
    case 1:
    case 2: return validateRasterDerivativeRecipe(value);
    case 3:
    case 4: return validateAreaRecipe(value);
    default: return invalid();
  }
}

export function canonicalCarrierDerivativeRecipeJson(value: unknown): string {
  const recipe = validateCarrierDerivativeRecipe(value);
  return `${JSON.stringify(JSON.parse(canonicalJson(recipe)), null, 2)}\n`;
}

export function bindCarrierComparisonProcessor(
  savedRecipe: CarrierDerivativeRecipe, processor: ImageMagickProcessorDescriptorV1,
): CarrierDerivativeRecipe {
  const { recipeDigest: _savedDigest, ...source } = savedRecipe;
  const recipe = { ...source, processor };
  const recipeDigest = (recipe.schemaVersion === 3 || recipe.schemaVersion === 4)
    ? areaRecipeDigest(normalizeAreaRecipe(recipe, false))
    : computeRasterDerivativeRecipeDigest(recipe);
  return validateCarrierDerivativeRecipe({ ...recipe, recipeDigest });
}

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function pngCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = PNG_CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Validate PNG chunk CRCs and remove only the C2PA `caBX` chunk from the
 * temporary strict-decoder view. The original bytes are never rewritten or
 * used as metadata; all other chunks remain byte-for-byte present and are
 * still subject to the existing strict decoder's closed policy.
 */
function decodeDerivativePng(bytes: Uint8Array): ReturnType<typeof decodeStrictPng> {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new RasterDerivativeError("SOURCE_INVALID");
  const keptChunks: Uint8Array[] = [];
  let offset = PNG_SIGNATURE.byteLength;
  let removedCaBx = false;
  let sawIend = false;
  let sawIhdr = false;
  let sawIdat = false;
  let idatRunEnded = false;
  while (offset < bytes.byteLength) {
    if (sawIend || offset > bytes.byteLength - 12) throw new RasterDerivativeError("SOURCE_INVALID");
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    if (length > DERIVATIVE_LIMITS.sourceBytes || offset > bytes.byteLength - 12 - length) throw new RasterDerivativeError("SOURCE_INVALID");
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    const chunkEnd = crcOffset + 4;
    const type = ascii(bytes, typeStart, 4);
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new RasterDerivativeError("SOURCE_INVALID");
    const crcInput = new Uint8Array(4 + length);
    crcInput.set(bytes.subarray(typeStart, dataStart));
    crcInput.set(bytes.subarray(dataStart, crcOffset), 4);
    const declaredCrc = new DataView(bytes.buffer, bytes.byteOffset + crcOffset, 4).getUint32(0, false);
    if (pngCrc32(crcInput) !== declaredCrc) throw new RasterDerivativeError("SOURCE_INVALID");
    if (!sawIhdr) {
      if (type !== "IHDR") throw new RasterDerivativeError("SOURCE_INVALID");
      sawIhdr = true;
    }
    if (type === "IDAT") {
      if (idatRunEnded) throw new RasterDerivativeError("SOURCE_INVALID");
      sawIdat = true;
    } else if (sawIdat) {
      idatRunEnded = true;
    }
    if (type === "caBX") removedCaBx = true;
    else keptChunks.push(new Uint8Array(bytes.subarray(offset, chunkEnd)));
    if (type === "IEND") sawIend = true;
    offset = chunkEnd;
  }
  if (offset !== bytes.byteLength || !sawIend) throw new RasterDerivativeError("SOURCE_INVALID");
  if (!removedCaBx) return decodeStrictPng(bytes);
  const preflightBytes = new Uint8Array(PNG_SIGNATURE.byteLength + keptChunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  preflightBytes.set(PNG_SIGNATURE);
  let cursor = PNG_SIGNATURE.byteLength;
  for (const chunk of keptChunks) {
    preflightBytes.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return decodeStrictPng(preflightBytes);
}

function assertRasterDimensions(width: number, height: number, code: "SOURCE_INVALID" | "OUTPUT_INVALID"): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || Object.is(width, -0) || Object.is(height, -0) || width < 1 || height < 1 || width > DERIVATIVE_LIMITS.maxDimension || height > DERIVATIVE_LIMITS.maxDimension || width * height > DERIVATIVE_LIMITS.maxPixels) throw new RasterDerivativeError(code);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return Buffer.from(bytes.subarray(start, start + length)).toString("ascii");
}

type RasterWebpFailureCode = "SOURCE_INVALID" | "OUTPUT_INVALID";

function readLe32(bytes: Uint8Array, offset: number, failureCode: RasterWebpFailureCode): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new RasterDerivativeError(failureCode);
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function readLe24(bytes: Uint8Array, offset: number, failureCode: RasterWebpFailureCode): number {
  if (offset < 0 || offset + 3 > bytes.byteLength) throw new RasterDerivativeError(failureCode);
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function inspectWebpHeader(bytes: Uint8Array, failureCode: RasterWebpFailureCode = "SOURCE_INVALID", requireMetadataFree = false, requireLossless = false): Readonly<{ width: number; height: number; alpha: RasterDerivativeAlpha }> {
  if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") throw new RasterDerivativeError(failureCode);
  const riffLength = readLe32(bytes, 4, failureCode);
  if (riffLength + 8 !== bytes.byteLength) throw new RasterDerivativeError(failureCode);
  let offset = 12;
  let canvasDimensions: readonly [number, number] | undefined;
  let imageDimensions: readonly [number, number] | undefined;
  let imageChunk: "VP8 " | "VP8L" | undefined;
  let extendedChunkSeen = false;
  let alphaChunkSeen = false;
  let vp8xFlags = 0;
  let chunkCount = 0;
  let alpha: RasterDerivativeAlpha = "unknown";
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new RasterDerivativeError(failureCode);
    const type = ascii(bytes, offset, 4);
    const length = readLe32(bytes, offset + 4, failureCode);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.byteLength) throw new RasterDerivativeError(failureCode);
    if (requireMetadataFree && type !== "VP8 " && type !== "VP8L" && type !== "VP8X" && type !== "ALPH") throw new RasterDerivativeError(failureCode);
    if (type === "VP8X") {
      if (length < 10 || (requireMetadataFree && (length !== 10 || chunkCount !== 0)) || extendedChunkSeen) throw new RasterDerivativeError(failureCode);
      extendedChunkSeen = true;
      vp8xFlags = bytes[dataStart]!;
      if (requireMetadataFree && (bytes[dataStart + 1] !== 0 || bytes[dataStart + 2] !== 0 || bytes[dataStart + 3] !== 0 || (vp8xFlags & 0xc1) !== 0 || (vp8xFlags & 0x2e) !== 0)) throw new RasterDerivativeError(failureCode);
      alpha = (vp8xFlags & 0x10) === 0 ? "opaque" : "has-alpha";
      canvasDimensions = [1 + readLe24(bytes, dataStart + 4, failureCode), 1 + readLe24(bytes, dataStart + 7, failureCode)];
    } else if (type === "VP8 ") {
      if (length < 10 || bytes[dataStart + 3] !== 0x9d || bytes[dataStart + 4] !== 0x01 || bytes[dataStart + 5] !== 0x2a || (requireMetadataFree && imageChunk !== undefined)) throw new RasterDerivativeError(failureCode);
      const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart + 6, 4);
      imageDimensions = [view.getUint16(0, true) & 0x3fff, view.getUint16(2, true) & 0x3fff];
      if (alpha === "unknown") alpha = "opaque";
      imageChunk = "VP8 ";
    } else if (type === "VP8L") {
      if (length < 5 || bytes[dataStart] !== 0x2f || (requireMetadataFree && (imageChunk !== undefined || alphaChunkSeen))) throw new RasterDerivativeError(failureCode);
      const width = 1 + (bytes[dataStart + 1]! | ((bytes[dataStart + 2]! & 0x3f) << 8));
      const height = 1 + ((bytes[dataStart + 2]! >> 6) | (bytes[dataStart + 3]! << 2) | ((bytes[dataStart + 4]! & 0xf) << 10));
      imageDimensions = [width, height];
      if (alpha === "unknown") alpha = (bytes[dataStart + 4]! & 0x10) === 0 ? "opaque" : "has-alpha";
      imageChunk = "VP8L";
    } else if (type === "ALPH") {
      if (requireMetadataFree && (!extendedChunkSeen || alphaChunkSeen || imageChunk !== undefined)) throw new RasterDerivativeError(failureCode);
      alphaChunkSeen = true;
      alpha = "has-alpha";
    }
    offset = dataEnd + (length % 2);
    if (offset > bytes.byteLength) throw new RasterDerivativeError(failureCode);
    chunkCount += 1;
  }
  if (imageDimensions === undefined || (requireLossless && imageChunk !== "VP8L") || (requireMetadataFree && imageChunk === undefined)) throw new RasterDerivativeError(failureCode);
  if (requireMetadataFree && ((alphaChunkSeen && (vp8xFlags & 0x10) === 0) || (imageChunk === "VP8 " && (vp8xFlags & 0x10) !== 0 && !alphaChunkSeen))) throw new RasterDerivativeError(failureCode);
  if (canvasDimensions !== undefined && (canvasDimensions[0] !== imageDimensions[0] || canvasDimensions[1] !== imageDimensions[1])) throw new RasterDerivativeError(failureCode);
  assertRasterDimensions(imageDimensions[0], imageDimensions[1], failureCode);
  if (canvasDimensions !== undefined) assertRasterDimensions(canvasDimensions[0], canvasDimensions[1], failureCode);
  return Object.freeze({ width: imageDimensions[0], height: imageDimensions[1], alpha });
}

function inspectSource(bytes: Uint8Array, recipe: RasterDerivativeRecipe): Readonly<{ width: number; height: number; decode: "png-pixels-decoded" | "webp-header-only" }> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > DERIVATIVE_LIMITS.sourceBytes) throw new RasterDerivativeError("SOURCE_INVALID");
  if (computeSha256(bytes) !== recipe.sourceSha256) throw new RasterDerivativeError("SOURCE_CHECKSUM_MISMATCH");
  const inspection = inspectRasterIllustrationSource(bytes, recipe.sourceMime);
  return Object.freeze({ width: inspection.width, height: inspection.height, decode: inspection.verification });
}

function killProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* cleanup is best effort */ }
  }
}

type RunMagick = (
  args: readonly string[], input: Uint8Array | undefined, maxOutputBytes: number, timeoutMs: number,
) => Promise<Uint8Array>;

interface BoundMagick {
  readonly path: string;
  readonly sha256: Sha256Digest;
  readonly signal: AbortSignal | undefined;
}

async function authenticateBoundMagick(bound: BoundMagick): Promise<void> {
  if (bound.signal?.aborted) throw new RasterDerivativeError("PROCESS_CANCELLED");
  const invalid = () => new RasterDerivativeError("PROCESSOR_MISMATCH");
  try {
    if (await realpath(bound.path) !== bound.path) throw invalid();
    const bin = dirname(bound.path);
    const packageRoot = dirname(bin);
    for (const directory of [bin, packageRoot]) {
      const metadata = await stat(directory);
      if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o222) !== 0) throw invalid();
    }
    const store = await stat(dirname(packageRoot));
    if (!store.isDirectory() || store.uid !== 0
        || ((store.mode & 0o022) !== 0 && (store.mode & 0o1000) === 0)) throw invalid();
    const file = await open(bound.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.uid !== 0 || (before.mode & 0o222) !== 0 ||
          (before.mode & 0o111) === 0 || before.size < 1 || before.size > 1024 * 1024) throw invalid();
      const bytes = await file.readFile();
      const after = await file.stat();
      if (bytes.byteLength !== before.size || before.size !== after.size ||
          before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs ||
          computeSha256(bytes) !== bound.sha256) throw invalid();
    } finally {
      await file.close();
    }
  } catch {
    throw invalid();
  }
  if (bound.signal?.aborted) throw new RasterDerivativeError("PROCESS_CANCELLED");
}

async function runMagick(
  args: readonly string[], input: Uint8Array | undefined, maxOutputBytes: number, timeoutMs: number,
  bound?: BoundMagick, abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  if (bound !== undefined) await authenticateBoundMagick(bound);
  const signal = bound?.signal ?? abortSignal;
  if (signal?.aborted) throw new RasterDerivativeError("PROCESS_CANCELLED");
  return await new Promise<Uint8Array>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bound?.path ?? MAGICK_EXECUTABLE, [...args], {
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(bound === undefined ? {} : { env: { PATH: "", LANG: "C", LC_ALL: "C" } }),
      });
    } catch {
      reject(new RasterDerivativeError("PROCESSOR_UNAVAILABLE"));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let failure: RasterDerivativeFailureCode | undefined;
    let closed = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const terminate = (code: RasterDerivativeFailureCode): void => {
      if (failure === undefined) failure = code;
      killProcess(child, "SIGTERM");
      forceKill ??= setTimeout(() => {
        killProcess(child, "SIGKILL");
        if (bound === undefined) finish();
      }, DERIVATIVE_LIMITS.killGraceMs);
    };
    const onAbort = (): void => terminate("PROCESS_CANCELLED");
    const finish = (error?: RasterDerivativeError): void => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", onAbort);
      if (deadline !== undefined) clearTimeout(deadline);
      if (forceKill !== undefined) clearTimeout(forceKill);
      if (error !== undefined) reject(error);
      else if (failure !== undefined) reject(new RasterDerivativeError(failure));
      else resolve(new Uint8Array(Buffer.concat(chunks)));
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (closed || failure !== undefined) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxOutputBytes) { terminate("PROCESS_OUTPUT_LIMIT"); return; }
      chunks.push(bytes);
    });
    child.stderr.resume();
    child.stdout.on("error", () => terminate("PROCESS_FAILED"));
    child.stderr.on("error", () => terminate("PROCESS_FAILED"));
    child.stdin.on("error", () => terminate("PROCESS_FAILED"));
    child.on("error", () => terminate("PROCESSOR_UNAVAILABLE"));
    child.on("close", (code) => {
      if (failure !== undefined) { finish(); return; }
      if (code !== 0) { finish(new RasterDerivativeError("PROCESS_FAILED")); return; }
      finish();
    });
    deadline = setTimeout(() => terminate("PROCESS_TIMEOUT"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try { if (input === undefined) child.stdin.end(); else child.stdin.end(Buffer.from(input)); } catch { terminate("PROCESS_FAILED"); }
  });
}

function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new RasterDerivativeError("PROCESS_FAILED"); }
}

export function parseImageMagickVersion(output: string): string | null {
  const match = /^\s*Version:\s*ImageMagick\s+([0-9][0-9A-Za-z.+-]*)\b/mu.exec(output);
  const version = match?.[1];
  return version !== undefined && Buffer.byteLength(version, "utf8") <= DERIVATIVE_LIMITS.processorVersionBytes && VERSION.test(version) ? version : null;
}

export function supportsImageMagickFormat(output: string, format: "PNG" | "WEBP"): boolean {
  for (const line of output.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    const formatIndex = columns.slice(0, 2).findIndex((column) => column === format || column === `${format}*`);
    if (formatIndex >= 0 && columns.slice(formatIndex + 1, formatIndex + 3).some((column) => /^rw[+-]$/u.test(column))) return true;
  }
  return false;
}

export function probeMagickDerivativeCapability(): Promise<DerivativeCapabilityStatus> {
  return probeMagick(runMagick);
}

async function probeMagick(run: RunMagick): Promise<DerivativeCapabilityStatus> {
  try {
    const version = parseImageMagickVersion(decodeText(await run(["-version"], undefined, DERIVATIVE_LIMITS.maxProbeOutputBytes, DERIVATIVE_LIMITS.processTimeoutMs)));
    if (version === null) return Object.freeze({ available: false, code: "DERIVATIVE_PROCESSOR_UNAVAILABLE", reason: "The fixed ImageMagick processor identity was not recognized." });
    const formats = decodeText(await run(["-list", "format"], undefined, DERIVATIVE_LIMITS.maxProbeOutputBytes, DERIVATIVE_LIMITS.processTimeoutMs));
    if (!supportsImageMagickFormat(formats, "PNG") || !supportsImageMagickFormat(formats, "WEBP")) return Object.freeze({ available: false, code: "DERIVATIVE_PROCESSOR_UNAVAILABLE", reason: "The fixed ImageMagick processor lacks required PNG/WebP delegates." });
    return Object.freeze({ available: true, processor: Object.freeze({ kind: "imagemagick", executable: MAGICK_EXECUTABLE, version, binarySha256: null, closureSha256: null, identityScope: "same-host-version-only" }) });
  } catch (error) {
    if (error instanceof RasterDerivativeError && (error.code === "PROCESS_CANCELLED" || error.code === "PROCESSOR_MISMATCH")) throw error;
    return Object.freeze({ available: false, code: "DERIVATIVE_PROCESSOR_UNAVAILABLE", reason: "The fixed ImageMagick processor is unavailable." });
  }
}

function sameProcessor(left: ImageMagickProcessorDescriptorV1, right: ImageMagickProcessorDescriptorV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function argsFor(recipe: RasterDerivativeRecipe): readonly string[] {
  const input = recipe.sourceMime === "image/png" ? "png:-" : "webp:-";
  const output = recipe.output.mime === "image/png" ? "png32:-" : "webp:-";
  return [input, "-colorspace", "sRGB", "-filter", recipe.output.filter, "-resize", `${recipe.output.width}x${recipe.output.height}`, "-gravity", "center", "-background", "none", "-extent", `${recipe.output.width}x${recipe.output.height}`, "-strip", "-depth", "8", "-quality", String(recipe.output.quality), "-define", `webp:method=${recipe.output.method}`, ...(recipe.schemaVersion === 2 ? ["-define", "webp:use-sharp-yuv=true"] : []), output];
}

function alphaFromRgba(rgba8: Uint8Array): RasterDerivativeAlpha {
  for (let index = 3; index < rgba8.length; index += 4) if (rgba8[index] !== 255) return "has-alpha";
  return "opaque";
}

export interface RasterDerivativePayloadInspectionV1 {
  readonly width: number;
  readonly height: number;
  readonly alpha: RasterDerivativeAlpha;
  /** PNG is pixel-decoded; WebP is a strict metadata-free header check only. */
  readonly verification: "png-pixels-decoded" | "webp-header-only";
}

export interface RasterIllustrationSourceInspectionV1 {
  readonly width: number;
  readonly height: number;
  readonly alpha: RasterDerivativeAlpha;
  /** PNG is pixel-decoded; WebP is a strict metadata-free header check only. */
  readonly verification: "png-pixels-decoded" | "webp-header-only";
}

export function inspectRasterIllustrationSource(bytes: Uint8Array, mime: RasterDerivativeMime): RasterIllustrationSourceInspectionV1 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > DERIVATIVE_LIMITS.sourceBytes) throw new RasterDerivativeError("SOURCE_INVALID");
  if (mime === "image/png") {
    try {
      const decoded = decodeDerivativePng(bytes);
      return Object.freeze({ width: decoded.width, height: decoded.height, alpha: alphaFromRgba(decoded.rgba8), verification: "png-pixels-decoded" });
    } catch {
      throw new RasterDerivativeError("SOURCE_INVALID");
    }
  }
  if (mime === "image/webp") {
    const decoded = inspectWebpHeader(bytes, "SOURCE_INVALID", true);
    return Object.freeze({ width: decoded.width, height: decoded.height, alpha: "unknown", verification: "webp-header-only" });
  }
  throw new RasterDerivativeError("SOURCE_INVALID");
}

export function inspectRasterDerivativePayload(bytes: Uint8Array, mime: RasterDerivativeMime, requireLossless = false): RasterDerivativePayloadInspectionV1 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > DERIVATIVE_LIMITS.outputBytes) throw new RasterDerivativeError("OUTPUT_INVALID");
  if (mime === "image/png") {
    try {
      const decoded = decodeStrictPng(bytes);
      return Object.freeze({ width: decoded.width, height: decoded.height, alpha: alphaFromRgba(decoded.rgba8), verification: "png-pixels-decoded" });
    } catch {
      throw new RasterDerivativeError("OUTPUT_INVALID");
    }
  }
  if (mime === "image/webp") {
    const decoded = inspectWebpHeader(bytes, "OUTPUT_INVALID", true, requireLossless);
    return Object.freeze({ width: decoded.width, height: decoded.height, alpha: decoded.alpha, verification: "webp-header-only" });
  }
  throw new RasterDerivativeError("OUTPUT_INVALID");
}

function parseIdentify(textValue: string): Readonly<{ width: number; height: number; alpha: RasterDerivativeAlpha }> {
  const match = /^([A-Za-z0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([A-Za-z0-9]+)(?:\s+[0-9.]+)?\s*$/u.exec(textValue.trim());
  if (match === null) throw new RasterDerivativeError("OUTPUT_INVALID");
  const width = Number(match[2]);
  const height = Number(match[3]);
  assertRasterDimensions(width, height, "OUTPUT_INVALID");
  return Object.freeze({ width, height, alpha: match[4]!.toLowerCase().endsWith("a") ? "has-alpha" : "opaque" });
}

async function verifyWebpOutput(bytes: Uint8Array, recipe: CarrierDerivativeRecipe, run: RunMagick): Promise<Readonly<{ width: number; height: number; alpha: RasterDerivativeAlpha }>> {
  const header = inspectWebpHeader(bytes, "OUTPUT_INVALID", true, isRgb6Recipe(recipe));
  if (header.width !== recipe.output.width || header.height !== recipe.output.height) throw new RasterDerivativeError("OUTPUT_INVALID");
  let identify: string;
  try {
    identify = decodeText(await run(["webp:-", "-format", "%m %w %h %[channels]", "info:-"], bytes, DERIVATIVE_LIMITS.maxProbeOutputBytes, DERIVATIVE_LIMITS.processTimeoutMs));
  } catch (error) {
    if (error instanceof RasterDerivativeError && (error.code === "PROCESS_TIMEOUT" || error.code === "PROCESS_OUTPUT_LIMIT" || error.code === "PROCESS_CANCELLED" || error.code === "PROCESSOR_MISMATCH")) throw error;
    throw new RasterDerivativeError("OUTPUT_INVALID");
  }
  const decoded = parseIdentify(identify);
  if (decoded.width !== header.width || decoded.height !== header.height) throw new RasterDerivativeError("OUTPUT_INVALID");
  if (header.alpha !== "unknown" && decoded.alpha !== header.alpha) throw new RasterDerivativeError("OUTPUT_INVALID");
  return decoded;
}

export function renderRasterDerivative(sourceBytes: Uint8Array, recipeValue: unknown): Promise<RasterDerivativeOutputV1> {
  return renderWithMagick(sourceBytes, recipeValue, runMagick);
}

async function renderWithMagick(sourceBytes: Uint8Array, recipeValue: unknown, run: RunMagick): Promise<RasterDerivativeOutputV1> {
  let recipe: RasterDerivativeRecipe;
  try { recipe = validateRasterDerivativeRecipe(recipeValue); } catch (error) { if (error instanceof RasterDerivativeError) throw error; throw new RasterDerivativeError("INVALID_RECIPE"); }
  if (!(sourceBytes instanceof Uint8Array) || sourceBytes.byteLength < 1 || sourceBytes.byteLength > DERIVATIVE_LIMITS.sourceBytes) throw new RasterDerivativeError("SOURCE_INVALID");
  // The caller may retain and mutate its Uint8Array while the fixed processor
  // is being probed. Work from a bounded snapshot so the checked bytes are the
  // bytes sent to ImageMagick and the caller's source remains untouched.
  const sourceBytesSnapshot = new Uint8Array(sourceBytes);
  const source = inspectSource(sourceBytesSnapshot, recipe);
  const capability = await probeMagick(run);
  if (!capability.available) throw new RasterDerivativeError("PROCESSOR_UNAVAILABLE");
  if (!sameProcessor(capability.processor, recipe.processor)) throw new RasterDerivativeError("PROCESSOR_MISMATCH");
  const outputBytes = await run(argsFor(recipe), sourceBytesSnapshot, DERIVATIVE_LIMITS.outputBytes, DERIVATIVE_LIMITS.processTimeoutMs);
  if (outputBytes.byteLength < 1 || outputBytes.byteLength > DERIVATIVE_LIMITS.outputBytes) throw new RasterDerivativeError("OUTPUT_INVALID");
  let width = recipe.output.width;
  let height = recipe.output.height;
  let alpha: RasterDerivativeAlpha = "unknown";
  let verification: RasterDerivativeOutputV1["verification"];
  if (recipe.output.mime === "image/png") {
    let decoded: ReturnType<typeof decodeStrictPng>;
    try { decoded = decodeStrictPng(outputBytes, recipe.output.width, recipe.output.height); } catch { throw new RasterDerivativeError("OUTPUT_INVALID"); }
    width = decoded.width; height = decoded.height; alpha = alphaFromRgba(decoded.rgba8); verification = "png-pixels-decoded";
  } else {
    const decoded = await verifyWebpOutput(outputBytes, recipe, run);
    width = decoded.width; height = decoded.height; alpha = decoded.alpha; verification = "processor-decoded-dimensions";
  }
  if (source.width < 1 || source.height < 1) throw new RasterDerivativeError("SOURCE_INVALID");
  return Object.freeze({ sourceSha256: recipe.sourceSha256, recipeDigest: recipe.recipeDigest, processor: capability.processor, mime: recipe.output.mime, bytes: new Uint8Array(outputBytes), sha256: computeSha256(outputBytes), byteLength: outputBytes.byteLength, width, height, alpha, verification });
}

export function verifyRasterDerivativeOutput(
  output: RasterDerivativeOutputV1, recipe: CarrierDerivativeRecipe,
): RasterDerivativeReceiptV1 {
  if (output.recipeDigest !== recipe.recipeDigest) throw new RasterDerivativeError("OUTPUT_INVALID");
  if (output.sourceSha256 !== recipe.sourceSha256) throw new RasterDerivativeError("SOURCE_CHECKSUM_MISMATCH");
  if (
    canonicalJson(output.processor) !== canonicalJson(recipe.processor)
    || output.mime !== recipe.output.mime
    || output.width !== recipe.output.width
    || output.height !== recipe.output.height
    || (output.alpha !== "opaque" && output.alpha !== "has-alpha" && output.alpha !== "unknown")
    || (output.verification !== "png-pixels-decoded" && output.verification !== "processor-decoded-dimensions")
    || !(output.bytes instanceof Uint8Array)
    || output.byteLength !== output.bytes.byteLength
    || output.byteLength < 1
    || output.byteLength > DERIVATIVE_LIMITS.outputBytes
    || computeSha256(output.bytes) !== output.sha256
  ) throw new RasterDerivativeError("OUTPUT_INVALID");
  if (isRgb6Recipe(recipe)) {
    const header = inspectWebpHeader(output.bytes, "OUTPUT_INVALID", true, true);
    if (header.width !== output.width || header.height !== output.height || header.alpha !== output.alpha) {
      throw new RasterDerivativeError("OUTPUT_INVALID");
    }
  }
  const payload: Omit<RasterDerivativeReceiptV1, "receiptDigest"> = Object.freeze({
    schema: DERIVATIVE_RECEIPT_SCHEMA,
    schemaVersion: DERIVATIVE_RECEIPT_SCHEMA_VERSION,
    sourceSha256: output.sourceSha256,
    recipeDigest: output.recipeDigest,
    outputSha256: output.sha256,
    byteLength: output.byteLength,
    mime: output.mime,
    width: output.width,
    height: output.height,
    alpha: output.alpha,
    verification: output.verification,
    processor: Object.freeze({ identityScope: output.processor.identityScope }),
  });
  return Object.freeze({ ...payload, receiptDigest: computeSha256(Buffer.from(`${DERIVATIVE_RECEIPT_DIGEST_BASIS}${canonicalJson(payload)}`, "utf8")) });
}

/** Encode an in-memory scene raster without accessing a destination. */
export function renderSceneWebp(
  source: Uint8Array, width: number, height: number, quality?: number, sharpChroma = false, filter?: RasterDerivativeFilter, recipeId?: string,
) {
  return encodeSceneWebp(source, width, height, runMagick, quality, sharpChroma, filter, recipeId);
}

/** @internal Encode the bounded Area sampler handoff without profiles or ancillary chunks. */
export function encodeAreaPng(rgba: Uint8Array, width: number, height: number,
  maximumByteLength = DERIVATIVE_LIMITS.sourceBytes,
): Uint8Array {
  dimensions(width, height);
  if (rgba.byteLength !== width * height * 4) throw new RasterDerivativeError("SOURCE_INVALID");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    scanlines.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  function chunk(type: string, bytes: Uint8Array): Buffer {
    const value = Buffer.allocUnsafe(bytes.length + 12);
    value.writeUInt32BE(bytes.length);
    value.write(type, 4, "ascii");
    value.set(bytes, 8);
    value.writeUInt32BE(pngCrc32(value.subarray(4, 8 + bytes.length)), 8 + bytes.length);
    return value;
  }
  // Bound the generated PNG with the same input limit as the established encoder path.
  const fixedBytes = PNG_SIGNATURE.length + header.length + 3 * 12;
  if (!Number.isSafeInteger(maximumByteLength) || maximumByteLength <= fixedBytes
      || maximumByteLength > DERIVATIVE_LIMITS.sourceBytes) throw new RasterDerivativeError("PROCESS_OUTPUT_LIMIT");
  let compressed: Buffer;
  try {
    compressed = deflateSync(scanlines, { maxOutputLength: maximumByteLength - fixedBytes });
  } catch (error) {
    if (error instanceof RangeError && (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new RasterDerivativeError("PROCESS_OUTPUT_LIMIT");
    }
    throw new RasterDerivativeError("PROCESS_FAILED");
  }
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", new Uint8Array())]);
}

/** Encode the complete reviewed PNG canvas via the opt-in, alpha-weighted sampler. */
export async function renderSceneWebpArea(source: Uint8Array, options: Readonly<{
  width: number;
  height: number;
  quality?: number;
  recipeId?: string;
  signal?: AbortSignal;
  rgb6?: boolean;
}>): Promise<{
  readonly recipe: AreaRecipe;
  readonly output: RasterDerivativeOutputV1;
  readonly receipt: RasterDerivativeReceiptV1;
}> {
  const { width, height, rgb6 = false, quality = rgb6 ? 100 : 94, signal } = options;
  if (rgb6 && options.quality !== undefined) throw new RasterDerivativeError("INVALID_RECIPE");
  const recipeId = options.recipeId ?? (rgb6 ? "scene-webp-area-rgb6" : "scene-webp-area");
  if (signal?.aborted) throw new RasterDerivativeError("PROCESS_CANCELLED");
  if (!(source instanceof Uint8Array) || source.byteLength < 1 || source.byteLength > DERIVATIVE_LIMITS.sourceBytes) {
    throw new RasterDerivativeError("SOURCE_INVALID");
  }
  const snapshot = new Uint8Array(source);
  let decoded: ReturnType<typeof decodeStrictPng>;
  try { decoded = decodeStrictPng(snapshot); } catch { throw new RasterDerivativeError("SOURCE_INVALID"); }
  const run: RunMagick = (args, input, limit, timeout) => runMagick(args, input, limit, timeout, undefined, signal);
  const capability = await probeMagick(run);
  if (!capability.available) throw new RasterDerivativeError("PROCESSOR_UNAVAILABLE");
  const normalized = normalizeAreaRecipe({
    schema: DERIVATIVE_RECIPE_SCHEMA_ID, schemaVersion: rgb6 ? 4 : 3, recipeId, recipeRevision: 1,
    sourceSha256: computeSha256(snapshot), sourceMime: "image/png", sourceWidth: decoded.width,
    sourceHeight: decoded.height, processor: capability.processor,
    output: {
      mime: "image/webp", width, height, fit: "fill", colorSpace: "srgb", metadata: "stripped",
      alpha: "preserve", quality, method: 6, chroma: "sharp-yuv", resample: AREA_RESAMPLE_ID,
      ...(rgb6 ? { encoding: RGB6_ENCODING_ID } : {}),
    },
  }, false);
  const recipe = Object.freeze({ ...normalized, recipeDigest: areaRecipeDigest(normalized) });
  const output = await executeAreaRecipe(decoded, recipe, run, signal);
  return { recipe, output, receipt: verifyRasterDerivativeOutput(output, recipe) };
}

/** Replay only a validated carrier recipe against its authenticated source and processor. */
export async function renderCarrierDerivative(
  source: Uint8Array, savedRecipe: CarrierDerivativeRecipe,
): Promise<RasterDerivativeOutputV1> {
  const recipe = validateCarrierDerivativeRecipe(savedRecipe);
  if (recipe.schemaVersion === 1 || recipe.schemaVersion === 2) return renderRasterDerivative(source, recipe);
  if (!(source instanceof Uint8Array) || source.byteLength < 1 || source.byteLength > DERIVATIVE_LIMITS.sourceBytes) {
    throw new RasterDerivativeError("SOURCE_INVALID");
  }
  const snapshot = new Uint8Array(source);
  if (computeSha256(snapshot) !== recipe.sourceSha256) throw new RasterDerivativeError("SOURCE_CHECKSUM_MISMATCH");
  let decoded: ReturnType<typeof decodeStrictPng>;
  try { decoded = decodeStrictPng(snapshot); } catch { throw new RasterDerivativeError("SOURCE_INVALID"); }
  if (decoded.width !== recipe.sourceWidth || decoded.height !== recipe.sourceHeight) {
    throw new RasterDerivativeError("SOURCE_INVALID");
  }
  const run: RunMagick = (args, input, limit, timeout) => runMagick(args, input, limit, timeout);
  const capability = await probeMagick(run);
  if (!capability.available) throw new RasterDerivativeError("PROCESSOR_UNAVAILABLE");
  if (!sameProcessor(recipe.processor, capability.processor)) throw new RasterDerivativeError("PROCESSOR_MISMATCH");
  return executeAreaRecipe(decoded, recipe, run);
}

async function executeAreaRecipe(
  decoded: ReturnType<typeof decodeStrictPng>, recipe: AreaRecipe,
  run: RunMagick, signal?: AbortSignal,
): Promise<RasterDerivativeOutputV1> {
  const { width, height } = recipe.output;
  const deadline = performance.now() + DERIVATIVE_LIMITS.processTimeoutMs;
  const checkBudget = (): void => {
    if (signal?.aborted) throw new RasterDerivativeError("PROCESS_CANCELLED");
    if (performance.now() > deadline) throw new RasterDerivativeError("PROCESS_TIMEOUT");
  };
  checkBudget();
  const rgba = downsampleArea(decoded, width, height, checkBudget);
  const rgb6 = isRgb6Recipe(recipe);
  if (rgb6) quantizeAreaRgb6(rgba, width, height, checkBudget);
  checkBudget();
  const png = encodeAreaPng(rgba, width, height);
  checkBudget();
  const encoded = await run(["png:-", "-colorspace", "sRGB", "-strip", "-depth", "8", "-quality",
    String(recipe.output.quality), "-define", `webp:method=${recipe.output.method}`,
    "-define", "webp:use-sharp-yuv=true",
    ...(rgb6 ? ["-define", "webp:lossless=true"] : []),
    "webp:-"], png, DERIVATIVE_LIMITS.outputBytes, DERIVATIVE_LIMITS.processTimeoutMs);
  if (encoded.byteLength < 1 || encoded.byteLength > DERIVATIVE_LIMITS.outputBytes) throw new RasterDerivativeError("OUTPUT_INVALID");
  const verified = await verifyWebpOutput(encoded, recipe, run);
  return Object.freeze({
    sourceSha256: recipe.sourceSha256, recipeDigest: recipe.recipeDigest, processor: recipe.processor,
    mime: "image/webp", bytes: new Uint8Array(encoded), sha256: computeSha256(encoded), byteLength: encoded.byteLength,
    ...verified, verification: "processor-decoded-dimensions",
  });
}

/** Decode a bounded still WebP through the existing processor, preserving its canvas. */
export async function decodeWebpForTrace(source: Uint8Array, maxPixels: number): Promise<RasterDerivativeOutputV1> {
  if (!(source instanceof Uint8Array) || source.byteLength < 1 || source.byteLength > DERIVATIVE_LIMITS.sourceBytes) {
    throw new RasterDerivativeError("SOURCE_INVALID");
  }
  const snapshot = new Uint8Array(source);
  const { width, height } = inspectRasterIllustrationSource(snapshot, "image/webp");
  if (width * height > maxPixels) throw new RasterDerivativeError("SOURCE_INVALID");
  const capability = await probeMagickDerivativeCapability();
  if (!capability.available) throw new RasterDerivativeError("PROCESSOR_UNAVAILABLE");
  const recipe = createRasterDerivativeRecipe({
    recipeId: "scene-trace-webp", recipeRevision: 1,
    sourceSha256: computeSha256(snapshot), sourceMime: "image/webp", processor: capability.processor,
    output: {
      mime: "image/png", width, height, fit: "contain-pad", colorSpace: "srgb",
      metadata: "stripped", alpha: "preserve", quality: 94, method: 6, filter: "Lanczos",
    },
  });
  return renderRasterDerivative(snapshot, recipe);
}

/** Use a host-pinned, read-only Nix store entry with an empty executable search path. */
export function renderSceneWebpWithNixMagick(
  source: Uint8Array,
  width: number,
  height: number,
  authority: Readonly<{ path: string; sha256: Sha256Digest }>,
  signal?: AbortSignal,
) {
  const { path, sha256 } = authority;
  if (!/^\/nix\/store\/[0-9a-z]{32}-imagemagick-[0-9A-Za-z.+-]+\/bin\/magick$/u.test(path)
      || !DIGEST.test(sha256)) {
    return Promise.reject(new RasterDerivativeError("PROCESSOR_MISMATCH"));
  }
  const bound: BoundMagick = { path, sha256, signal };
  const run: RunMagick = (args, bytes, limit, timeout) => runMagick(args, bytes, limit, timeout, bound);
  return encodeSceneWebp(source, width, height, run);
}

async function encodeSceneWebp(
  source: Uint8Array, width: number, height: number, run: RunMagick,
  quality = 94, sharpChroma = false, filter: RasterDerivativeFilter = "Lanczos", recipeId = "scene-webp",
): Promise<{
  readonly recipe: RasterDerivativeRecipe;
  readonly output: RasterDerivativeOutputV1;
  readonly receipt: RasterDerivativeReceiptV1;
}> {
  if (!(source instanceof Uint8Array) || source.byteLength < 1 || source.byteLength > DERIVATIVE_LIMITS.sourceBytes) {
    throw new RasterDerivativeError("SOURCE_INVALID");
  }
  const snapshot = new Uint8Array(source);
  const capability = await probeMagick(run);
  if (!capability.available) throw new RasterDerivativeError("PROCESSOR_UNAVAILABLE");
  const base = {
    recipeId, recipeRevision: 1,
    sourceSha256: computeSha256(snapshot), sourceMime: "image/png",
    processor: capability.processor,
    output: {
      mime: "image/webp", width, height, fit: "contain-pad", colorSpace: "srgb",
      metadata: "stripped", alpha: "preserve", quality, method: 6, filter,
    },
  } as const;
  const draft = {
    schema: DERIVATIVE_RECIPE_SCHEMA_ID, schemaVersion: 2, ...base,
    output: { ...base.output, chroma: "sharp-yuv" },
  };
  const recipe = sharpChroma
    ? validateRasterDerivativeRecipe({ ...draft, recipeDigest: computeRasterDerivativeRecipeDigest(draft) })
    : createRasterDerivativeRecipe(base);
  const output = await renderWithMagick(snapshot, recipe, run);
  return { recipe, output, receipt: verifyRasterDerivativeOutput(output, recipe) };
}
