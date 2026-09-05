import { fail, fromCaught, ok, type DiagnosticContext } from "../diagnostics.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import type { Result } from "../types.js";
import { TOOL_VERSION } from "../version.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import { BRAND_RECIPE_OPERATIONS_DIGEST_BASIS } from "./recipes.js";

export const DERIVED_RECEIPT_SCHEMA_ID = "tfsb.derived-receipt" as const;
export const DERIVED_RECEIPT_SCHEMA_VERSION = 1 as const;
export const DERIVED_RECEIPT_DIGEST_BASIS = "tfsb.derived-receipt-v1\n" as const;
export const DERIVED_RECEIPT_MAX_BYTES = 1048576; // 1 MiB
export const DERIVED_RECEIPT_MAX_COUNT = 128;

export interface DerivedReceiptUsedToken {
  readonly id: string;
  readonly type: "color" | "gradient" | "dimension" | "opacity";
  readonly canonicalValue: string;
}

export interface DerivedReceiptSourceRecord {
  readonly assetId: string;
  readonly canonicalAssetDigest: Sha256Digest;
}

export interface DerivedReceiptAccessibilityResult {
  readonly mode: "labelled" | "decorative" | "consumer_labelled";
  readonly title?: string;
  readonly description?: string;
}

export interface DerivedReceiptResourceCounts {
  readonly operationCount: number;
  readonly elementCount: number;
}

export interface BrandDerivedReceipt {
  readonly schema: typeof DERIVED_RECEIPT_SCHEMA_ID;
  readonly schemaVersion: typeof DERIVED_RECEIPT_SCHEMA_VERSION;
  readonly targetAssetId: string;
  readonly targetFilename: string;
  readonly recipeId: string;
  readonly recipeFileDigest: Sha256Digest;
  readonly recipeDefinitionDigest: Sha256Digest;
  readonly orderedOperations: readonly Readonly<Record<string, unknown>>[];
  readonly orderedOperationsDigest: Sha256Digest;
  readonly tokenFileDigest: Sha256Digest;
  readonly usedTokens: readonly DerivedReceiptUsedToken[];
  readonly sourceChain: readonly DerivedReceiptSourceRecord[];
  readonly targetSchemaVersion: 2;
  readonly targetTomlByteDigest: Sha256Digest;
  readonly targetModelDigest: Sha256Digest;
  readonly targetSvgDigest: Sha256Digest;
  readonly accessibilityPolicy: "preserve" | "replace-explicit" | "decorative";
  readonly accessibilityResult: DerivedReceiptAccessibilityResult;
  readonly resourceCounts: DerivedReceiptResourceCounts;
  readonly toolVersion: string;
  readonly receiptDigest: Sha256Digest;
}

export type DerivedReceiptPayload = Omit<BrandDerivedReceipt, "receiptDigest">;

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256_PREFIXED_REGEX = /^sha256:[0-9a-f]{64}$/;

function context(source?: string): DiagnosticContext {
  return { operation: "parse", domain: "manifest", ...(source === undefined ? {} : { source }) };
}

function expectKeys(
  record: UnknownRecord,
  allowed: readonly string[],
  ctx: DiagnosticContext,
  location: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(ctx, "SCHEMA_UNKNOWN_KEY", "Unknown key '" + key + "'.", location === "" ? key : location + "." + key);
    }
  }
}

function asRecord(value: unknown, ctx: DiagnosticContext, location: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a JSON object.", location);
  }
  return value as UnknownRecord;
}

function asArray(value: unknown, ctx: DiagnosticContext, location: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a JSON array.", location);
  }
  return value;
}

function asString(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a string.", location);
  }
  return value;
}

function asInteger(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
  min?: number,
  max?: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a safe integer.", location);
  }
  if (min !== undefined && value < min) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "Integer " + value + " must be at least " + min + ".", location);
  }
  if (max !== undefined && value > max) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "Integer " + value + " must be at most " + max + ".", location);
  }
  return value;
}

function validateIdentifier(value: unknown, ctx: DiagnosticContext, location: string): string {
  const str = asString(value, ctx, location);
  if (Buffer.byteLength(str, "utf8") > 64 || !IDENTIFIER_REGEX.test(str)) {
    fail(
      ctx,
      "SCHEMA_INVALID_IDENTIFIER",
      "Identifier '" + str + "' must match 1..64 ASCII kebab bytes [a-z][a-z0-9]*(?:-[a-z0-9]+)*.",
      location,
    );
  }
  return str;
}

function validateSha256Digest(value: unknown, ctx: DiagnosticContext, location: string): Sha256Digest {
  const str = asString(value, ctx, location);
  if (!SHA256_PREFIXED_REGEX.test(str)) {
    fail(ctx, "SCHEMA_INVALID_DIGEST", "Digest '" + str + "' must match 'sha256:<64-lowercase-hex>'.", location);
  }
  return str as Sha256Digest;
}

function validateCanonicalUsedTokenValue(
  type: DerivedReceiptUsedToken["type"],
  value: string,
  ctx: DiagnosticContext,
  location: string,
): void {
  if (type === "color") {
    if (!/^#[0-9A-F]{8}$/.test(value)) {
      fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Color canonicalValue must be uppercase #RRGGBBAA.", location);
    }
    return;
  }
  if (type === "opacity") {
    if (!/^(?:0|[1-9][0-9]{0,6})$/.test(value) || Number(value) > 1000000) {
      fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Opacity canonicalValue must be a canonical integer in 0..1000000.", location);
    }
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Token canonicalValue must be valid canonical JSON.", location);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || encodeCanonicalJson(parsed) !== value) {
    fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Token canonicalValue must be one canonical JSON object.", location);
  }
  const record = parsed as UnknownRecord;
  if (type === "dimension") {
    expectKeys(record, ["unit", "value"], ctx, location);
    const unit = asString(record.unit, ctx, location + ".unit");
    if (unit !== "px" && unit !== "percent-millionth" && unit !== "viewbox-millionth") {
      fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Dimension canonicalValue has an unsupported unit.", location + ".unit");
    }
    asInteger(record.value, ctx, location + ".value", -1000000000, 1000000000);
    return;
  }
  expectKeys(record, ["kind", "stops", "units", "x1", "x2", "y1", "y2"], ctx, location);
  if (record.kind !== "linear") {
    fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Gradient canonicalValue kind must be linear.", location + ".kind");
  }
  const units = asString(record.units, ctx, location + ".units");
  if (units !== "object-bounding-box-millionth" && units !== "user-space") {
    fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Gradient canonicalValue has unsupported units.", location + ".units");
  }
  const coordinate = (field: "x1" | "x2" | "y1" | "y2"): number =>
    units === "object-bounding-box-millionth"
      ? asInteger(record[field], ctx, location + "." + field, 0, 1000000)
      : asInteger(record[field], ctx, location + "." + field);
  coordinate("x1"); coordinate("x2"); coordinate("y1"); coordinate("y2");
  const stops = asArray(record.stops, ctx, location + ".stops");
  if (stops.length < 2 || stops.length > 16) {
    fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Gradient canonicalValue must contain 2..16 ordered stops.", location + ".stops");
  }
  let previousOffset = -1;
  for (let index = 0; index < stops.length; index++) {
    const stopLocation = location + ".stops[" + index + "]";
    const stop = asRecord(stops[index], ctx, stopLocation);
    const hasLiteral = stop.color !== undefined;
    const hasReference = stop.colorToken !== undefined || stop.resolvedColor !== undefined;
    expectKeys(stop, hasLiteral ? ["color", "offset"] : ["colorToken", "offset", "resolvedColor"], ctx, stopLocation);
    if (hasLiteral === hasReference) {
      fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Gradient stop must contain either one literal color or one token reference with resolved color.", stopLocation);
    }
    if (hasLiteral) {
      if (typeof stop.color !== "string" || !/^#[0-9A-F]{8}$/.test(stop.color)) {
        fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Gradient literal stop color must be uppercase #RRGGBBAA.", stopLocation + ".color");
      }
    } else {
      validateIdentifier(stop.colorToken, ctx, stopLocation + ".colorToken");
      if (typeof stop.resolvedColor !== "string" || !/^#[0-9A-F]{8}$/.test(stop.resolvedColor)) {
        fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Gradient referenced stop must bind an uppercase resolved #RRGGBBAA color.", stopLocation + ".resolvedColor");
      }
    }
    const offset = asInteger(stop.offset, ctx, stopLocation + ".offset", 0, 1000000);
    if (offset < previousOffset) {
      fail(ctx, "DERIVED_RECEIPT_INVALID_TOKEN_VALUE", "Gradient stop offsets must be nondecreasing.", stopLocation + ".offset");
    }
    previousOffset = offset;
  }
}

export function toDerivedReceiptPreimageDto(payload: DerivedReceiptPayload): Record<string, unknown> {
  const sortedTokens = [...payload.usedTokens].sort((a, b) => compareUtf8(a.id, b.id));
  return {
    accessibilityPolicy: payload.accessibilityPolicy,
    accessibilityResult: {
      ...(payload.accessibilityResult.description === undefined ? {} : { description: payload.accessibilityResult.description }),
      mode: payload.accessibilityResult.mode,
      ...(payload.accessibilityResult.title === undefined ? {} : { title: payload.accessibilityResult.title }),
    },
    orderedOperations: payload.orderedOperations,
    orderedOperationsDigest: payload.orderedOperationsDigest,
    recipeDefinitionDigest: payload.recipeDefinitionDigest,
    recipeFileDigest: payload.recipeFileDigest,
    recipeId: payload.recipeId,
    resourceCounts: {
      elementCount: payload.resourceCounts.elementCount,
      operationCount: payload.resourceCounts.operationCount,
    },
    schema: payload.schema,
    schemaVersion: payload.schemaVersion,
    sourceChain: payload.sourceChain.map((s) => ({
      assetId: s.assetId,
      canonicalAssetDigest: s.canonicalAssetDigest,
    })),
    targetAssetId: payload.targetAssetId,
    targetFilename: payload.targetFilename,
    targetModelDigest: payload.targetModelDigest,
    targetSchemaVersion: payload.targetSchemaVersion,
    targetSvgDigest: payload.targetSvgDigest,
    targetTomlByteDigest: payload.targetTomlByteDigest,
    tokenFileDigest: payload.tokenFileDigest,
    toolVersion: payload.toolVersion,
    usedTokens: sortedTokens.map((t) => ({
      canonicalValue: t.canonicalValue,
      id: t.id,
      type: t.type,
    })),
  };
}

export function computeDerivedReceiptDigest(payload: DerivedReceiptPayload): Sha256Digest {
  const dto = toDerivedReceiptPreimageDto(payload);
  const json = encodeCanonicalJson(dto);
  const preimage = DERIVED_RECEIPT_DIGEST_BASIS + json;
  return computeSha256(Buffer.from(preimage, "utf8"));
}

export function createBrandDerivedReceipt(
  payload: Omit<BrandDerivedReceipt, "schema" | "schemaVersion" | "toolVersion" | "receiptDigest"> & {
    toolVersion?: string;
  },
): BrandDerivedReceipt {
  const fullPayload: DerivedReceiptPayload = {
    schema: DERIVED_RECEIPT_SCHEMA_ID,
    schemaVersion: DERIVED_RECEIPT_SCHEMA_VERSION,
    targetAssetId: payload.targetAssetId,
    targetFilename: payload.targetFilename,
    recipeId: payload.recipeId,
    recipeFileDigest: payload.recipeFileDigest,
    recipeDefinitionDigest: payload.recipeDefinitionDigest,
    orderedOperations: Object.freeze(payload.orderedOperations.map((operation) => Object.freeze(structuredClone(operation)))),
    orderedOperationsDigest: payload.orderedOperationsDigest,
    tokenFileDigest: payload.tokenFileDigest,
    usedTokens: Object.freeze([...payload.usedTokens].sort((a, b) => compareUtf8(a.id, b.id))),
    sourceChain: Object.freeze([...payload.sourceChain]),
    targetSchemaVersion: 2,
    targetTomlByteDigest: payload.targetTomlByteDigest,
    targetModelDigest: payload.targetModelDigest,
    targetSvgDigest: payload.targetSvgDigest,
    accessibilityPolicy: payload.accessibilityPolicy,
    accessibilityResult: Object.freeze({ ...payload.accessibilityResult }),
    resourceCounts: Object.freeze({ ...payload.resourceCounts }),
    toolVersion: payload.toolVersion ?? TOOL_VERSION,
  };

  const receiptDigest = computeDerivedReceiptDigest(fullPayload);
  return Object.freeze({
    ...fullPayload,
    receiptDigest,
  });
}

export function parseBrandDerivedReceipt(
  source: string,
  sourceName = ".tfsb/derived/receipt.json",
): Result<BrandDerivedReceipt> {
  const ctx = context(sourceName);
  try {
    const byteLength = Buffer.byteLength(source, "utf8");
    if (byteLength > DERIVED_RECEIPT_MAX_BYTES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Derived receipt size " + byteLength + " bytes exceeds limit " + DERIVED_RECEIPT_MAX_BYTES + " bytes.",
        sourceName,
      );
    }

    if (source.startsWith("\uFEFF")) {
      fail(ctx, "SCHEMA_INVALID_BOM", "UTF-8 BOM is forbidden in derived receipt.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse derived receipt as JSON.");
    }

    const root = asRecord(parsed, ctx, "");
    expectKeys(
      root,
      [
        "schema",
        "schemaVersion",
        "targetAssetId",
        "targetFilename",
        "recipeId",
        "recipeFileDigest",
        "recipeDefinitionDigest",
        "orderedOperations",
        "orderedOperationsDigest",
        "tokenFileDigest",
        "usedTokens",
        "sourceChain",
        "targetSchemaVersion",
        "targetTomlByteDigest",
        "targetModelDigest",
        "targetSvgDigest",
        "accessibilityPolicy",
        "accessibilityResult",
        "resourceCounts",
        "toolVersion",
        "receiptDigest",
      ],
      ctx,
      "",
    );

    const schema = asString(root.schema, ctx, "schema");
    if (schema !== DERIVED_RECEIPT_SCHEMA_ID) {
      fail(ctx, "SCHEMA_INVALID_ID", "Expected schema '" + DERIVED_RECEIPT_SCHEMA_ID + "', got '" + schema + "'.", "schema");
    }

    const schemaVersion = asInteger(root.schemaVersion, ctx, "schemaVersion");
    if (schemaVersion !== DERIVED_RECEIPT_SCHEMA_VERSION) {
      fail(
        ctx,
        "SCHEMA_INVALID_VERSION",
        "Expected schemaVersion " + DERIVED_RECEIPT_SCHEMA_VERSION + ", got " + schemaVersion + ".",
        "schemaVersion",
      );
    }

    const targetAssetId = validateIdentifier(root.targetAssetId, ctx, "targetAssetId");
    const targetFilename = asString(root.targetFilename, ctx, "targetFilename");
    if (targetFilename !== targetAssetId + ".svg") {
      fail(
        ctx,
        "DERIVED_RECEIPT_INVALID_FILENAME",
        "targetFilename '" + targetFilename + "' must match '" + targetAssetId + ".svg'.",
        "targetFilename",
      );
    }

    const recipeId = validateIdentifier(root.recipeId, ctx, "recipeId");
    const recipeFileDigest = validateSha256Digest(root.recipeFileDigest, ctx, "recipeFileDigest");
    const recipeDefinitionDigest = validateSha256Digest(root.recipeDefinitionDigest, ctx, "recipeDefinitionDigest");
    const orderedOperationsRaw = asArray(root.orderedOperations, ctx, "orderedOperations");
    if (orderedOperationsRaw.length < 1 || orderedOperationsRaw.length > 16) {
      fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "orderedOperations must contain between 1 and 16 operations.", "orderedOperations");
    }
    const orderedOperations = Object.freeze(orderedOperationsRaw.map((operation, index) =>
      Object.freeze({ ...asRecord(operation, ctx, "orderedOperations[" + index + "]") }),
    ));
    const orderedOperationsDigest = validateSha256Digest(root.orderedOperationsDigest, ctx, "orderedOperationsDigest");
    const computedOperationsDigest = computeSha256(Buffer.from(
      BRAND_RECIPE_OPERATIONS_DIGEST_BASIS + encodeCanonicalJson(orderedOperations),
      "utf8",
    ));
    if (orderedOperationsDigest !== computedOperationsDigest) {
      fail(ctx, "DERIVED_RECEIPT_INVALID_OPERATIONS_DIGEST", "orderedOperationsDigest does not bind orderedOperations.", "orderedOperationsDigest");
    }
    const tokenFileDigest = validateSha256Digest(root.tokenFileDigest, ctx, "tokenFileDigest");

    // usedTokens
    const usedTokensRaw = asArray(root.usedTokens, ctx, "usedTokens");
    const usedTokens: DerivedReceiptUsedToken[] = [];
    const seenTokenIds = new Set<string>();
    for (let i = 0; i < usedTokensRaw.length; i++) {
      const loc = "usedTokens[" + i + "]";
      const rec = asRecord(usedTokensRaw[i], ctx, loc);
      expectKeys(rec, ["id", "type", "canonicalValue"], ctx, loc);

      const id = validateIdentifier(rec.id, ctx, loc + ".id");
      if (seenTokenIds.has(id)) {
        fail(ctx, "BRAND_DUPLICATE_TOKEN", "Duplicate token id '" + id + "' in usedTokens.", loc + ".id");
      }
      seenTokenIds.add(id);

      const typeStr = asString(rec.type, ctx, loc + ".type");
      if (typeStr !== "color" && typeStr !== "gradient" && typeStr !== "dimension" && typeStr !== "opacity") {
        fail(ctx, "SCHEMA_INVALID_ENUM", "Invalid token type '" + typeStr + "' in usedTokens.", loc + ".type");
      }
      const type = typeStr as "color" | "gradient" | "dimension" | "opacity";
      const canonicalValue = asString(rec.canonicalValue, ctx, loc + ".canonicalValue");
      validateCanonicalUsedTokenValue(type, canonicalValue, ctx, loc + ".canonicalValue");

      usedTokens.push(Object.freeze({ id, type, canonicalValue }));
    }
    usedTokens.sort((a, b) => compareUtf8(a.id, b.id));

    // sourceChain
    const sourceChainRaw = asArray(root.sourceChain, ctx, "sourceChain");
    if (sourceChainRaw.length === 0 || sourceChainRaw.length > 8) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "sourceChain length " + sourceChainRaw.length + " must be between 1 and 8.",
        "sourceChain",
      );
    }
    const sourceChain: DerivedReceiptSourceRecord[] = [];
    const seenSourceIds = new Set<string>();
    for (let i = 0; i < sourceChainRaw.length; i++) {
      const loc = "sourceChain[" + i + "]";
      const rec = asRecord(sourceChainRaw[i], ctx, loc);
      expectKeys(rec, ["assetId", "canonicalAssetDigest"], ctx, loc);

      const assetId = validateIdentifier(rec.assetId, ctx, loc + ".assetId");
      if (seenSourceIds.has(assetId)) {
        fail(ctx, "DERIVED_RECEIPT_DUPLICATE_SOURCE", "Duplicate source-chain asset id '" + assetId + "'.", loc + ".assetId");
      }
      seenSourceIds.add(assetId);
      const canonicalAssetDigest = validateSha256Digest(rec.canonicalAssetDigest, ctx, loc + ".canonicalAssetDigest");
      sourceChain.push(Object.freeze({ assetId, canonicalAssetDigest }));
    }

    const targetSchemaVersion = asInteger(root.targetSchemaVersion, ctx, "targetSchemaVersion");
    if (targetSchemaVersion !== 2) {
      fail(ctx, "SCHEMA_INVALID_VERSION", "targetSchemaVersion must be 2, got " + targetSchemaVersion + ".", "targetSchemaVersion");
    }

    const targetTomlByteDigest = validateSha256Digest(root.targetTomlByteDigest, ctx, "targetTomlByteDigest");
    const targetModelDigest = validateSha256Digest(root.targetModelDigest, ctx, "targetModelDigest");
    const targetSvgDigest = validateSha256Digest(root.targetSvgDigest, ctx, "targetSvgDigest");

    const accessibilityPolicyStr = asString(root.accessibilityPolicy, ctx, "accessibilityPolicy");
    if (accessibilityPolicyStr !== "preserve" && accessibilityPolicyStr !== "replace-explicit" && accessibilityPolicyStr !== "decorative") {
      fail(
        ctx,
        "SCHEMA_INVALID_ENUM",
        "Invalid accessibilityPolicy '" + accessibilityPolicyStr + "'.",
        "accessibilityPolicy",
      );
    }
    const accessibilityPolicy = accessibilityPolicyStr as "preserve" | "replace-explicit" | "decorative";

    const accResultRec = asRecord(root.accessibilityResult, ctx, "accessibilityResult");
    expectKeys(accResultRec, ["mode", "title", "description"], ctx, "accessibilityResult");
    const modeStr = asString(accResultRec.mode, ctx, "accessibilityResult.mode");
    if (modeStr !== "labelled" && modeStr !== "decorative" && modeStr !== "consumer_labelled") {
      fail(ctx, "SCHEMA_INVALID_ENUM", "Invalid accessibilityResult mode '" + modeStr + "'.", "accessibilityResult.mode");
    }
    const mode = modeStr as "labelled" | "decorative" | "consumer_labelled";
    const title = accResultRec.title === undefined ? undefined : asString(accResultRec.title, ctx, "accessibilityResult.title");
    const description = accResultRec.description === undefined ? undefined : asString(accResultRec.description, ctx, "accessibilityResult.description");
    const accessibilityResult: DerivedReceiptAccessibilityResult = Object.freeze({
      mode,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
    });
    if (mode === "decorative" && (title !== undefined || description !== undefined)) {
      fail(ctx, "DERIVED_RECEIPT_INVALID_ACCESSIBILITY", "Decorative accessibility results cannot contain title or description.", "accessibilityResult");
    }
    if (mode === "labelled" && (title === undefined || title.trim() === "")) {
      fail(ctx, "DERIVED_RECEIPT_INVALID_ACCESSIBILITY", "Labelled accessibility results require a nonblank title.", "accessibilityResult.title");
    }
    if (accessibilityPolicy === "decorative" && mode !== "decorative") {
      fail(ctx, "DERIVED_RECEIPT_INVALID_ACCESSIBILITY", "Decorative policy requires a decorative result.", "accessibilityResult.mode");
    }
    if (accessibilityPolicy === "replace-explicit" && mode !== "labelled") {
      fail(ctx, "DERIVED_RECEIPT_INVALID_ACCESSIBILITY", "replace-explicit policy requires a labelled result.", "accessibilityResult.mode");
    }
    if (accessibilityPolicy === "preserve" && mode === "decorative" && (title !== undefined || description !== undefined)) {
      fail(ctx, "DERIVED_RECEIPT_INVALID_ACCESSIBILITY", "Preserved decorative results cannot contain text.", "accessibilityResult");
    }

    const resCountsRec = asRecord(root.resourceCounts, ctx, "resourceCounts");
    expectKeys(resCountsRec, ["operationCount", "elementCount"], ctx, "resourceCounts");
    const operationCount = asInteger(resCountsRec.operationCount, ctx, "resourceCounts.operationCount", 1, 2048);
    const elementCount = asInteger(resCountsRec.elementCount, ctx, "resourceCounts.elementCount", 0, 10000);
    const resourceCounts: DerivedReceiptResourceCounts = Object.freeze({ operationCount, elementCount });
    if (operationCount !== orderedOperations.length) {
      fail(ctx, "DERIVED_RECEIPT_COUNT_MISMATCH", "resourceCounts.operationCount must equal orderedOperations length.", "resourceCounts.operationCount");
    }

    const toolVersion = asString(root.toolVersion, ctx, "toolVersion");
    const receiptDigest = validateSha256Digest(root.receiptDigest, ctx, "receiptDigest");

    const payload: DerivedReceiptPayload = {
      schema: DERIVED_RECEIPT_SCHEMA_ID,
      schemaVersion: DERIVED_RECEIPT_SCHEMA_VERSION,
      targetAssetId,
      targetFilename,
      recipeId,
      recipeFileDigest,
      recipeDefinitionDigest,
      orderedOperations,
      orderedOperationsDigest,
      tokenFileDigest,
      usedTokens: Object.freeze(usedTokens),
      sourceChain: Object.freeze(sourceChain),
      targetSchemaVersion: 2,
      targetTomlByteDigest,
      targetModelDigest,
      targetSvgDigest,
      accessibilityPolicy,
      accessibilityResult,
      resourceCounts,
      toolVersion,
    };

    const computedDigest = computeDerivedReceiptDigest(payload);
    if (receiptDigest !== computedDigest) {
      fail(
        ctx,
        "DERIVED_RECEIPT_INVALID_SELF_DIGEST",
        "Derived receipt self-digest mismatch: declared '" + receiptDigest + "', computed '" + computedDigest + "'.",
        "receiptDigest",
      );
    }

    const receipt: BrandDerivedReceipt = Object.freeze({
      ...payload,
      receiptDigest,
    });

    return ok(receipt);
  } catch (error) {
    return fromCaught(error, ctx, "SCHEMA_INVALID_SYNTAX", "Failed to validate derived receipt.");
  }
}

export function serializeBrandDerivedReceipt(receipt: BrandDerivedReceipt): string {
  const orderedDto = {
    schema: receipt.schema,
    schemaVersion: receipt.schemaVersion,
    targetAssetId: receipt.targetAssetId,
    targetFilename: receipt.targetFilename,
    recipeId: receipt.recipeId,
    recipeFileDigest: receipt.recipeFileDigest,
    recipeDefinitionDigest: receipt.recipeDefinitionDigest,
    orderedOperations: receipt.orderedOperations,
    orderedOperationsDigest: receipt.orderedOperationsDigest,
    tokenFileDigest: receipt.tokenFileDigest,
    usedTokens: [...receipt.usedTokens].sort((a, b) => compareUtf8(a.id, b.id)),
    sourceChain: receipt.sourceChain,
    targetSchemaVersion: receipt.targetSchemaVersion,
    targetTomlByteDigest: receipt.targetTomlByteDigest,
    targetModelDigest: receipt.targetModelDigest,
    targetSvgDigest: receipt.targetSvgDigest,
    accessibilityPolicy: receipt.accessibilityPolicy,
    accessibilityResult: receipt.accessibilityResult,
    resourceCounts: receipt.resourceCounts,
    toolVersion: receipt.toolVersion,
    receiptDigest: receipt.receiptDigest,
  };

  return JSON.stringify(orderedDto, null, 2) + "\n";
}
