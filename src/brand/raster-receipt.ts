import { fail, fromCaught, ok, type DiagnosticContext } from "../diagnostics.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import type { Result } from "../types.js";
import { TOOL_VERSION } from "../version.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import { validateRasterDestination, type BrandExportAlpha, type BrandExportPurpose } from "./export-profile.js";

export const RASTER_RECEIPT_SCHEMA_ID = "tfsb.raster-receipt" as const;
export const RASTER_RECEIPT_SCHEMA_VERSION = 1 as const;
export const RASTER_RECEIPT_DIGEST_BASIS = "tfsb.raster-receipt-v1\n" as const;
export const RASTER_RECEIPT_MAX_BYTES = 1_048_576;
export const RASTER_RECEIPT_MAX_COUNT = 128;
export const RASTER_RECEIPT_DIR = ".tfsb/raster-receipts" as const;

export interface RasterAdapterDescriptor {
  readonly adapterId: "resvg-png-v1";
  readonly companionPackage: "@knowledge-forge-ai/tfsb-raster-resvg";
  readonly companionVersion: string;
  readonly backend: "wasm" | "native";
  readonly rendererPackage: "@resvg/resvg-wasm" | "@resvg/resvg-js";
  readonly rendererVersion: string;
  readonly rendererBuildDigest: Sha256Digest;
  readonly nodeMajor: number;
  readonly platformClaim: string;
  readonly qualificationId: string;
}

export interface RasterReceiptSource {
  readonly assetId: string;
  readonly canonicalAssetDigest: Sha256Digest;
  readonly svgDigest: Sha256Digest;
  readonly brandSystemDigest: Sha256Digest;
}

export interface RasterReceiptExportAuthority {
  readonly rawExportFileDigest: Sha256Digest;
  readonly exportDomainDigest: Sha256Digest;
  readonly profileId: string;
  readonly profileDigest: Sha256Digest;
  readonly outputId: string;
  readonly outputConfigDigest: Sha256Digest;
}

export interface RasterReceiptOutput {
  readonly destination: string;
  readonly width: number;
  readonly height: number;
  readonly purpose: BrandExportPurpose;
  readonly fit: "contain-pad";
  readonly background: "transparent" | `#${string}`;
  readonly colorSpace: "srgb";
  readonly alpha: BrandExportAlpha;
  readonly pngDigest: Sha256Digest;
  readonly decodedPixelDigest: Sha256Digest;
}

export interface RasterReceipt {
  readonly schema: typeof RASTER_RECEIPT_SCHEMA_ID;
  readonly schemaVersion: typeof RASTER_RECEIPT_SCHEMA_VERSION;
  readonly adapter: RasterAdapterDescriptor;
  readonly source: RasterReceiptSource;
  readonly exportAuthority: RasterReceiptExportAuthority;
  readonly output: RasterReceiptOutput;
  readonly evidence: {
    readonly toolVersion: string;
    readonly receiptDigest: Sha256Digest;
  };
}

export type RasterReceiptPayload = Omit<RasterReceipt, "evidence"> & { readonly evidence: { readonly toolVersion: string } };
type UnknownRecord = Record<string, unknown>;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RGBA = /^#[0-9A-F]{8}$/;
const SEMVER_LIKE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const PURPOSES = new Set(["png", "apple-touch-icon", "pwa-icon", "avatar", "social-card"]);

function context(source?: string): DiagnosticContext { return { operation: "parse", domain: "manifest", ...(source === undefined ? {} : { source }) }; }
function asRecord(value: unknown, ctx: DiagnosticContext, location: string): UnknownRecord { if (typeof value !== "object" || value === null || Array.isArray(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a JSON object.", location); return value as UnknownRecord; }
function asString(value: unknown, ctx: DiagnosticContext, location: string): string { if (typeof value !== "string") fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a string.", location); return value; }
function asInteger(value: unknown, ctx: DiagnosticContext, location: string, min: number, max: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a safe integer.", location); if (value < min || value > max) fail(ctx, "SCHEMA_INVALID_RANGE", `Expected ${min}..${max}.`, location); return value; }
function exactKeys(value: UnknownRecord, allowed: readonly string[], ctx: DiagnosticContext, location: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(ctx, "SCHEMA_UNKNOWN_KEY", `Unknown key '${key}'.`, location === "" ? key : `${location}.${key}`); for (const key of allowed) if (!(key in value)) fail(ctx, "SCHEMA_MISSING_KEY", `Missing required key '${key}'.`, location === "" ? key : `${location}.${key}`); }
function identifier(value: unknown, ctx: DiagnosticContext, location: string): string { const text = asString(value, ctx, location); if (Buffer.byteLength(text, "utf8") > 64 || !ID.test(text)) fail(ctx, "SCHEMA_INVALID_IDENTIFIER", "Expected a 1..64 byte lowercase kebab identifier.", location); return text; }
function digest(value: unknown, ctx: DiagnosticContext, location: string): Sha256Digest { const text = asString(value, ctx, location); if (!DIGEST.test(text)) fail(ctx, "SCHEMA_INVALID_DIGEST", "Expected sha256:<64-lowercase-hex>.", location); return text as Sha256Digest; }
function bounded(value: unknown, ctx: DiagnosticContext, location: string): string { const text = asString(value, ctx, location); if (Buffer.byteLength(text, "utf8") < 1 || Buffer.byteLength(text, "utf8") > 256 || /[\x00-\x1f\x7f]/.test(text)) fail(ctx, "SCHEMA_INVALID_STRING", "Expected 1..256 control-free UTF-8 bytes.", location); return text; }

function parseJsonWithoutDuplicateKeys(source: string): unknown {
  let index = 0;
  const whitespace = (): void => { while (/\s/.test(source[index] ?? "")) index++; };
  const parseString = (): string => {
    if (source[index] !== '"') throw new Error("Expected JSON string.");
    const start = index++;
    while (index < source.length) {
      const char = source[index++]!;
      if (char === '"') return JSON.parse(source.slice(start, index)) as string;
      if (char === "\\") { if (index >= source.length) break; const escaped = source[index++]!; if (escaped === "u") index += 4; }
      else if (char.charCodeAt(0) < 0x20) break;
    }
    throw new Error("Invalid JSON string.");
  };
  const parseValue = (): unknown => {
    whitespace();
    const char = source[index];
    if (char === '"') return parseString();
    if (char === "{") {
      index++; whitespace(); const object: UnknownRecord = {}; const keys = new Set<string>();
      if (source[index] === "}") { index++; return object; }
      while (true) {
        whitespace(); const key = parseString(); if (keys.has(key)) throw new Error(`Duplicate JSON key '${key}'.`); keys.add(key);
        whitespace(); if (source[index++] !== ":") throw new Error("Expected JSON colon."); object[key] = parseValue(); whitespace();
        const next = source[index++]; if (next === "}") return object; if (next !== ",") throw new Error("Expected JSON object delimiter.");
      }
    }
    if (char === "[") {
      index++; whitespace(); const values: unknown[] = []; if (source[index] === "]") { index++; return values; }
      while (true) { values.push(parseValue()); whitespace(); const next = source[index++]; if (next === "]") return values; if (next !== ",") throw new Error("Expected JSON array delimiter."); }
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) if (source.startsWith(literal, index)) { index += literal.length; return value; }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (match === null) throw new Error("Invalid JSON value."); index += match[0].length; return Number(match[0]);
  };
  const value = parseValue(); whitespace(); if (index !== source.length) throw new Error("Data follows JSON value."); return value;
}

export function rasterReceiptPath(profileId: string, outputId: string): string {
  if (!ID.test(profileId) || !ID.test(outputId)) throw new Error("Raster receipt identifiers must be lowercase kebab IDs.");
  return `${RASTER_RECEIPT_DIR}/${profileId}/${outputId}.receipt.json`;
}

export function parseRasterReceiptPath(path: string): Readonly<{ profileId: string; outputId: string }> | undefined {
  const match = /^\.tfsb\/raster-receipts\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.receipt\.json$/.exec(path);
  return match === null ? undefined : Object.freeze({ profileId: match[1]!, outputId: match[2]! });
}

export function computeRasterReceiptDigest(payload: RasterReceiptPayload): Sha256Digest {
  return computeSha256(Buffer.from(RASTER_RECEIPT_DIGEST_BASIS + encodeCanonicalJson(payload), "utf8"));
}

export function createRasterReceipt(payload: Omit<RasterReceiptPayload, "schema" | "schemaVersion" | "evidence"> & { readonly toolVersion?: string }): RasterReceipt {
  const preimage: RasterReceiptPayload = Object.freeze({ schema: RASTER_RECEIPT_SCHEMA_ID, schemaVersion: RASTER_RECEIPT_SCHEMA_VERSION, adapter: Object.freeze({ ...payload.adapter }), source: Object.freeze({ ...payload.source }), exportAuthority: Object.freeze({ ...payload.exportAuthority }), output: Object.freeze({ ...payload.output }), evidence: Object.freeze({ toolVersion: payload.toolVersion ?? TOOL_VERSION }) });
  return Object.freeze({ ...preimage, evidence: Object.freeze({ toolVersion: preimage.evidence.toolVersion, receiptDigest: computeRasterReceiptDigest(preimage) }) });
}

export function parseRasterReceipt(source: string, sourceName = ".tfsb/raster-receipts/receipt.json"): Result<RasterReceipt> {
  const ctx = context(sourceName);
  try {
    if (Buffer.byteLength(source, "utf8") > RASTER_RECEIPT_MAX_BYTES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Raster receipt exceeds 1 MiB.", sourceName);
    if (source.startsWith("\uFEFF")) fail(ctx, "SCHEMA_INVALID_BOM", "UTF-8 BOM is forbidden.", sourceName);
    let parsed: unknown; try { parsed = parseJsonWithoutDuplicateKeys(source); } catch (error) { fail(ctx, /Duplicate JSON key/.test(String(error)) ? "SCHEMA_DUPLICATE_KEY" : "SCHEMA_INVALID_SYNTAX", String(error)); }
    const root = asRecord(parsed, ctx, ""); exactKeys(root, ["schema", "schemaVersion", "adapter", "source", "exportAuthority", "output", "evidence"], ctx, "");
    if (asString(root.schema, ctx, "schema") !== RASTER_RECEIPT_SCHEMA_ID) fail(ctx, "SCHEMA_INVALID_ID", `Expected '${RASTER_RECEIPT_SCHEMA_ID}'.`, "schema");
    if (asInteger(root.schemaVersion, ctx, "schemaVersion", 1, 1) !== 1) fail(ctx, "SCHEMA_INVALID_VERSION", "Unsupported raster receipt version.", "schemaVersion");

    const a = asRecord(root.adapter, ctx, "adapter"); exactKeys(a, ["adapterId", "companionPackage", "companionVersion", "backend", "rendererPackage", "rendererVersion", "rendererBuildDigest", "nodeMajor", "platformClaim", "qualificationId"], ctx, "adapter");
    if (a.adapterId !== "resvg-png-v1" || a.companionPackage !== "@knowledge-forge-ai/tfsb-raster-resvg") fail(ctx, "RASTER_RECEIPT_INVALID_ADAPTER", "Receipt adapter identity is not the fixed v1 adapter.", "adapter");
    const backend = asString(a.backend, ctx, "adapter.backend"); if (backend !== "wasm" && backend !== "native") fail(ctx, "SCHEMA_INVALID_ENUM", "backend must be wasm or native.", "adapter.backend");
    const rendererPackage = asString(a.rendererPackage, ctx, "adapter.rendererPackage"); if ((backend === "wasm" && rendererPackage !== "@resvg/resvg-wasm") || (backend === "native" && rendererPackage !== "@resvg/resvg-js")) fail(ctx, "RASTER_RECEIPT_INVALID_ADAPTER", "Renderer package does not match backend.", "adapter.rendererPackage");
    const companionVersion = bounded(a.companionVersion, ctx, "adapter.companionVersion"); const rendererVersion = bounded(a.rendererVersion, ctx, "adapter.rendererVersion");
    if (!SEMVER_LIKE.test(companionVersion) || !SEMVER_LIKE.test(rendererVersion)) fail(ctx, "SCHEMA_INVALID_STRING", "Renderer and companion versions must be bounded version literals.", "adapter");
    const adapter: RasterAdapterDescriptor = Object.freeze({ adapterId: "resvg-png-v1", companionPackage: "@knowledge-forge-ai/tfsb-raster-resvg", companionVersion, backend, rendererPackage: rendererPackage as RasterAdapterDescriptor["rendererPackage"], rendererVersion, rendererBuildDigest: digest(a.rendererBuildDigest, ctx, "adapter.rendererBuildDigest"), nodeMajor: asInteger(a.nodeMajor, ctx, "adapter.nodeMajor", 1, 999), platformClaim: bounded(a.platformClaim, ctx, "adapter.platformClaim"), qualificationId: bounded(a.qualificationId, ctx, "adapter.qualificationId") });

    const s = asRecord(root.source, ctx, "source"); exactKeys(s, ["assetId", "canonicalAssetDigest", "svgDigest", "brandSystemDigest"], ctx, "source");
    const sourceDto: RasterReceiptSource = Object.freeze({ assetId: identifier(s.assetId, ctx, "source.assetId"), canonicalAssetDigest: digest(s.canonicalAssetDigest, ctx, "source.canonicalAssetDigest"), svgDigest: digest(s.svgDigest, ctx, "source.svgDigest"), brandSystemDigest: digest(s.brandSystemDigest, ctx, "source.brandSystemDigest") });

    const e = asRecord(root.exportAuthority, ctx, "exportAuthority"); exactKeys(e, ["rawExportFileDigest", "exportDomainDigest", "profileId", "profileDigest", "outputId", "outputConfigDigest"], ctx, "exportAuthority");
    const exportAuthority: RasterReceiptExportAuthority = Object.freeze({ rawExportFileDigest: digest(e.rawExportFileDigest, ctx, "exportAuthority.rawExportFileDigest"), exportDomainDigest: digest(e.exportDomainDigest, ctx, "exportAuthority.exportDomainDigest"), profileId: identifier(e.profileId, ctx, "exportAuthority.profileId"), profileDigest: digest(e.profileDigest, ctx, "exportAuthority.profileDigest"), outputId: identifier(e.outputId, ctx, "exportAuthority.outputId"), outputConfigDigest: digest(e.outputConfigDigest, ctx, "exportAuthority.outputConfigDigest") });

    const o = asRecord(root.output, ctx, "output"); exactKeys(o, ["destination", "width", "height", "purpose", "fit", "background", "colorSpace", "alpha", "pngDigest", "decodedPixelDigest"], ctx, "output");
    const purpose = asString(o.purpose, ctx, "output.purpose"); if (!PURPOSES.has(purpose)) fail(ctx, "SCHEMA_INVALID_ENUM", "Unknown PNG purpose.", "output.purpose");
    const background = asString(o.background, ctx, "output.background"); if (background !== "transparent" && !RGBA.test(background)) fail(ctx, "SCHEMA_INVALID_STRING", "background must be transparent or #RRGGBBAA.", "output.background");
    const alpha = asString(o.alpha, ctx, "output.alpha"); if (alpha !== "straight" && alpha !== "opaque") fail(ctx, "SCHEMA_INVALID_ENUM", "alpha must be straight or opaque.", "output.alpha");
    if (alpha === "opaque" && (background === "transparent" || background.slice(-2) !== "FF")) fail(ctx, "RASTER_RECEIPT_INVALID", "Opaque receipt output requires a fully opaque background.", "output.background");
    if (o.fit !== "contain-pad" || o.colorSpace !== "srgb") fail(ctx, "SCHEMA_INVALID_ENUM", "Unsupported raster output configuration.", "output");
    const output: RasterReceiptOutput = Object.freeze({ destination: validateRasterDestination(o.destination, "output.destination"), width: asInteger(o.width, ctx, "output.width", 1, 16_384), height: asInteger(o.height, ctx, "output.height", 1, 16_384), purpose: purpose as BrandExportPurpose, fit: "contain-pad", background: background as RasterReceiptOutput["background"], colorSpace: "srgb", alpha, pngDigest: digest(o.pngDigest, ctx, "output.pngDigest"), decodedPixelDigest: digest(o.decodedPixelDigest, ctx, "output.decodedPixelDigest") });
    if (output.width * output.height > 16_777_216) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Receipt output exceeds pixel limit.", "output");

    const ev = asRecord(root.evidence, ctx, "evidence"); exactKeys(ev, ["toolVersion", "receiptDigest"], ctx, "evidence"); const toolVersion = bounded(ev.toolVersion, ctx, "evidence.toolVersion"); const receiptDigest = digest(ev.receiptDigest, ctx, "evidence.receiptDigest");
    const payload: RasterReceiptPayload = Object.freeze({ schema: RASTER_RECEIPT_SCHEMA_ID, schemaVersion: RASTER_RECEIPT_SCHEMA_VERSION, adapter, source: sourceDto, exportAuthority, output, evidence: Object.freeze({ toolVersion }) });
    if (computeRasterReceiptDigest(payload) !== receiptDigest) fail(ctx, "RASTER_RECEIPT_INVALID", "Raster receipt self-digest mismatch.", "evidence.receiptDigest");
    return ok(Object.freeze({ ...payload, evidence: Object.freeze({ toolVersion, receiptDigest }) }));
  } catch (error) { return fromCaught(error, ctx, "SCHEMA_INVALID_SYNTAX", "Failed to validate raster receipt."); }
}

export function serializeRasterReceipt(receipt: RasterReceipt): string {
  return `${JSON.stringify({ schema: receipt.schema, schemaVersion: receipt.schemaVersion, adapter: receipt.adapter, source: receipt.source, exportAuthority: receipt.exportAuthority, output: receipt.output, evidence: receipt.evidence }, null, 2)}\n`;
}
