import { parse as parseToml, TomlError } from "smol-toml";

import { fail, fromCaught, ok, type DiagnosticContext } from "../diagnostics.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import type { Result } from "../types.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import { isValidBrandRole } from "./brand-schema.js";

export const BRAND_QA_SCHEMA_ID = "tfsb.brand-qa" as const;
export const BRAND_QA_SCHEMA_VERSION = 1 as const;
export const BRAND_QA_DIGEST_BASIS = "tfsb.brand-qa-v1\n" as const;
export const BRAND_QA_MAX_BYTES = 1_048_576;
export const BRAND_QA_MAX_PROFILES = 32;
export const BRAND_QA_MAX_CASES = 512;
export const BRAND_QA_MAX_VISUAL_CASES = 256;
export const BRAND_QA_MAX_TARGETS_PER_CASE = 128;
export const BRAND_QA_MAX_SIZES = 32;
export const BRAND_QA_MAX_BACKGROUNDS = 16;
export const BRAND_QA_MAX_EVALUATIONS_PER_PROFILE = 4_096;
export const BRAND_QA_MAX_DIMENSION = 16_384;
export const BRAND_QA_MAX_PIXELS_PER_EVALUATION = 16_777_216;
export const BRAND_QA_MAX_AGGREGATE_RGBA_BYTES = 256 * 1_048_576;
export const BRAND_QA_MAX_RESULT_BYTES = 16 * 1_048_576;

export const BRAND_QA_FORMATS = ["html", "json", "markdown"] as const;
export type BrandQaFormat = (typeof BRAND_QA_FORMATS)[number];
export type BrandQaRendererPolicy = "optional" | "required";
export type BrandQaBackground = "transparent" | `token:${string}` | `#${string}`;
export type BrandQaSize = readonly [number, number];

export const BRAND_QA_SEMANTIC_KINDS = [
  "accessibility",
  "canvas",
  "embedded-content",
  "external-reference",
  "inventory",
  "palette",
  "recipe",
] as const;
export const BRAND_QA_VISUAL_KINDS = [
  "baseline",
  "clipping",
  "pixel-bounds",
  "small-size-visibility",
  "transparent-bounds",
  "visible-padding",
] as const;
export type BrandQaSemanticKind = (typeof BRAND_QA_SEMANTIC_KINDS)[number];
export type BrandQaVisualKind = (typeof BRAND_QA_VISUAL_KINDS)[number];

export interface BrandQaProfile {
  readonly id: string;
  readonly renderer: BrandQaRendererPolicy;
  readonly formats: readonly BrandQaFormat[];
  readonly cases: readonly string[];
}

export interface BrandQaTargetSelector {
  readonly asset?: string;
  readonly family?: string;
  readonly role?: string;
  readonly variant?: string;
}

interface BrandQaCaseBase {
  readonly id: string;
  readonly kind: BrandQaSemanticKind | BrandQaVisualKind;
}

export interface BrandQaInventoryCase extends BrandQaCaseBase {
  readonly kind: "inventory";
  readonly family: string;
  readonly roles?: readonly string[];
}

export interface BrandQaAccessibilityCase extends BrandQaCaseBase, BrandQaTargetSelector {
  readonly kind: "accessibility";
  readonly requireConsistentLabels: boolean;
}

export interface BrandQaPaletteCase extends BrandQaCaseBase, BrandQaTargetSelector {
  readonly kind: "palette";
  readonly allowedTokens: readonly string[];
  readonly allowLiterals: boolean;
}

export interface BrandQaExternalReferenceCase extends BrandQaCaseBase, BrandQaTargetSelector {
  readonly kind: "external-reference";
  readonly forbidExternalUrls: boolean;
  readonly forbidExternalImages: boolean;
  readonly forbidExternalUses: boolean;
  readonly forbidExternalStyles: boolean;
  readonly forbidExternalFonts: boolean;
}

export interface BrandQaEmbeddedContentCase extends BrandQaCaseBase, BrandQaTargetSelector {
  readonly kind: "embedded-content";
  readonly forbidEmbeddedRaster: boolean;
  readonly forbidEmbeddedFonts: boolean;
}

export interface BrandQaRecipeCase extends BrandQaCaseBase {
  readonly kind: "recipe";
  readonly recipe?: string;
  readonly family?: string;
  readonly verifyProvenance: boolean;
  readonly verifyReceipts: boolean;
}

export interface BrandQaCanvasCase extends BrandQaCaseBase, BrandQaTargetSelector {
  readonly kind: "canvas";
  readonly requireViewbox: boolean;
  readonly enforceMinimumSize: boolean;
}

interface BrandQaVisualCaseBase extends BrandQaCaseBase, BrandQaTargetSelector {
  readonly kind: BrandQaVisualKind;
  readonly sizes: readonly BrandQaSize[];
  readonly backgrounds: readonly BrandQaBackground[];
}

export interface BrandQaPixelBoundsCase extends BrandQaVisualCaseBase {
  readonly kind: "pixel-bounds";
  readonly alphaThreshold: number;
}

export interface BrandQaTransparentBoundsCase extends BrandQaVisualCaseBase {
  readonly kind: "transparent-bounds";
  readonly alphaThreshold: number;
}

export interface BrandQaClippingCase extends BrandQaVisualCaseBase {
  readonly kind: "clipping";
  readonly forbiddenEdgePixels: number;
}

export interface BrandQaVisiblePaddingCase extends BrandQaVisualCaseBase {
  readonly kind: "visible-padding";
  readonly minimumPaddingPx?: number;
  readonly minimumPaddingToken?: string;
  readonly minimumPaddingRatio?: number;
}

export interface BrandQaSmallSizeVisibilityCase extends BrandQaVisualCaseBase {
  readonly kind: "small-size-visibility";
  readonly minimumVisiblePixels?: number;
  readonly minimumVisibleRatio?: number;
}

export interface BrandQaBaselineCase extends BrandQaVisualCaseBase {
  readonly kind: "baseline";
  readonly baselinePath: string;
  readonly baselineDigest: Sha256Digest;
  readonly rendererId: string;
  readonly rendererVersion: string;
  readonly platformClaim: string;
  readonly canonicalAssetDigest: Sha256Digest;
  readonly svgDigest: Sha256Digest;
}

export type BrandQaSemanticCase =
  | BrandQaInventoryCase
  | BrandQaAccessibilityCase
  | BrandQaPaletteCase
  | BrandQaExternalReferenceCase
  | BrandQaEmbeddedContentCase
  | BrandQaRecipeCase
  | BrandQaCanvasCase;
export type BrandQaVisualCase =
  | BrandQaPixelBoundsCase
  | BrandQaTransparentBoundsCase
  | BrandQaClippingCase
  | BrandQaVisiblePaddingCase
  | BrandQaSmallSizeVisibilityCase
  | BrandQaBaselineCase;
export type BrandQaCase = BrandQaSemanticCase | BrandQaVisualCase;

export interface BrandQaModel {
  readonly schema: typeof BRAND_QA_SCHEMA_ID;
  readonly schemaVersion: typeof BRAND_QA_SCHEMA_VERSION;
  readonly profiles: readonly BrandQaProfile[];
  readonly cases: readonly BrandQaCase[];
}

type UnknownRecord = Record<string, unknown>;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RGBA = /^#[0-9A-F]{8}$/;

function context(source?: string): DiagnosticContext {
  return { operation: "parse", domain: "project-toml", ...(source === undefined ? {} : { source }) };
}

function expectKeys(record: UnknownRecord, allowed: readonly string[], ctx: DiagnosticContext, location: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(ctx, "SCHEMA_UNKNOWN_KEY", `Unknown key '${key}'.`, location === "" ? key : `${location}.${key}`);
  }
}

function asRecord(value: unknown, ctx: DiagnosticContext, location: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML table.", location);
  return value as UnknownRecord;
}

function asArray(value: unknown, ctx: DiagnosticContext, location: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML array.", location);
  return value;
}

function asString(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a string.", location);
  return value;
}

function asBoolean(value: unknown, ctx: DiagnosticContext, location: string): boolean {
  if (typeof value !== "boolean") fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a boolean.", location);
  return value;
}

function asInteger(value: unknown, ctx: DiagnosticContext, location: string, min?: number, max?: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a safe integer.", location);
  if (min !== undefined && value < min) fail(ctx, "SCHEMA_INVALID_RANGE", `Integer ${value} must be at least ${min}.`, location);
  if (max !== undefined && value > max) fail(ctx, "SCHEMA_INVALID_RANGE", `Integer ${value} must be at most ${max}.`, location);
  return value;
}

function identifier(value: unknown, ctx: DiagnosticContext, location: string): string {
  const text = asString(value, ctx, location);
  if (!IDENTIFIER.test(text) || Buffer.byteLength(text, "utf8") > 64) fail(ctx, "SCHEMA_INVALID_IDENTIFIER", `Invalid brand identifier '${text}'.`, location);
  return text;
}

function role(value: unknown, ctx: DiagnosticContext, location: string): string {
  const text = asString(value, ctx, location);
  if (!isValidBrandRole(text)) fail(ctx, "SCHEMA_INVALID_ROLE", `Invalid brand role '${text}'.`, location);
  return text;
}

function uniqueStrings(value: unknown, ctx: DiagnosticContext, location: string, validate: (value: unknown, ctx: DiagnosticContext, location: string) => string = identifier): readonly string[] {
  const raw = asArray(value, ctx, location);
  const result = raw.map((entry, index) => validate(entry, ctx, `${location}[${index}]`));
  if (new Set(result).size !== result.length) fail(ctx, "SCHEMA_DUPLICATE_VALUE", `Duplicate value in '${location}'.`, location);
  return Object.freeze(result);
}

function selector(record: UnknownRecord, ctx: DiagnosticContext, location: string): BrandQaTargetSelector {
  const asset = record.asset === undefined ? undefined : identifier(record.asset, ctx, `${location}.asset`);
  const family = record.family === undefined ? undefined : identifier(record.family, ctx, `${location}.family`);
  const roleValue = record.role === undefined ? undefined : role(record.role, ctx, `${location}.role`);
  const variant = record.variant === undefined ? undefined : identifier(record.variant, ctx, `${location}.variant`);
  if ((asset === undefined) === (family === undefined)) fail(ctx, "BRAND_QA_INVALID_TARGET", "Exactly one of asset or family is required.", location);
  if (asset !== undefined && (roleValue !== undefined || variant !== undefined)) fail(ctx, "BRAND_QA_INVALID_TARGET", "Asset selectors cannot include role or variant.", location);
  return Object.freeze({ ...(asset === undefined ? {} : { asset }), ...(family === undefined ? {} : { family }), ...(roleValue === undefined ? {} : { role: roleValue }), ...(variant === undefined ? {} : { variant }) });
}

function sizes(value: unknown, ctx: DiagnosticContext, location: string): readonly BrandQaSize[] {
  const raw = asArray(value, ctx, location);
  if (raw.length < 1 || raw.length > BRAND_QA_MAX_SIZES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Visual case sizes must contain 1..${BRAND_QA_MAX_SIZES} entries.`, location);
  const result = raw.map((entry, index): BrandQaSize => {
    const pair = asArray(entry, ctx, `${location}[${index}]`);
    if (pair.length !== 2) fail(ctx, "SCHEMA_INVALID_TYPE", "A size must contain exactly width and height.", `${location}[${index}]`);
    const width = asInteger(pair[0], ctx, `${location}[${index}][0]`, 1, BRAND_QA_MAX_DIMENSION);
    const height = asInteger(pair[1], ctx, `${location}[${index}][1]`, 1, BRAND_QA_MAX_DIMENSION);
    if (width * height > BRAND_QA_MAX_PIXELS_PER_EVALUATION) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Visual evaluation exceeds ${BRAND_QA_MAX_PIXELS_PER_EVALUATION} pixels.`, `${location}[${index}]`);
    return Object.freeze([width, height]);
  });
  const keys = result.map(([width, height]) => `${width}x${height}`);
  if (new Set(keys).size !== keys.length) fail(ctx, "SCHEMA_DUPLICATE_VALUE", "Duplicate visual size.", location);
  result.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return Object.freeze(result);
}

function background(value: unknown, ctx: DiagnosticContext, location: string): BrandQaBackground {
  const text = asString(value, ctx, location);
  if (text === "transparent" || RGBA.test(text)) return text as BrandQaBackground;
  if (text.startsWith("token:")) {
    identifier(text.slice("token:".length), ctx, location);
    return text as BrandQaBackground;
  }
  fail(ctx, "BRAND_QA_INVALID_BACKGROUND", "Background must be transparent, token:<token-id>, or #RRGGBBAA.", location);
}

function backgrounds(value: unknown, ctx: DiagnosticContext, location: string): readonly BrandQaBackground[] {
  const raw = asArray(value, ctx, location);
  if (raw.length < 1 || raw.length > BRAND_QA_MAX_BACKGROUNDS) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Visual case backgrounds must contain 1..${BRAND_QA_MAX_BACKGROUNDS} entries.`, location);
  const result = raw.map((entry, index) => background(entry, ctx, `${location}[${index}]`));
  if (new Set(result).size !== result.length) fail(ctx, "SCHEMA_DUPLICATE_VALUE", "Duplicate visual background.", location);
  result.sort(compareUtf8);
  return Object.freeze(result);
}

function visualCommon(record: UnknownRecord, ctx: DiagnosticContext, location: string) {
  return { ...selector(record, ctx, location), sizes: sizes(record.sizes, ctx, `${location}.sizes`), backgrounds: backgrounds(record.backgrounds, ctx, `${location}.backgrounds`) };
}

function digest(value: unknown, ctx: DiagnosticContext, location: string): Sha256Digest {
  const text = asString(value, ctx, location);
  if (!SHA256.test(text)) fail(ctx, "SCHEMA_INVALID_DIGEST", "Expected sha256:<64 lowercase hex>.", location);
  return text as Sha256Digest;
}

function parseCase(record: UnknownRecord, ctx: DiagnosticContext, location: string): BrandQaCase {
  const id = identifier(record.id, ctx, `${location}.id`);
  const kind = asString(record.kind, ctx, `${location}.kind`);
  const targetKeys = ["asset", "family", "role", "variant"];
  const visualKeys = [...targetKeys, "sizes", "backgrounds"];
  switch (kind) {
    case "inventory": {
      expectKeys(record, ["id", "kind", "family", "roles"], ctx, location);
      const family = identifier(record.family, ctx, `${location}.family`);
      const roles = record.roles === undefined ? undefined : uniqueStrings(record.roles, ctx, `${location}.roles`, role);
      return Object.freeze({ id, kind, family, ...(roles === undefined ? {} : { roles }) });
    }
    case "accessibility":
      expectKeys(record, ["id", "kind", ...targetKeys, "require_consistent_labels"], ctx, location);
      return Object.freeze({ id, kind, ...selector(record, ctx, location), requireConsistentLabels: asBoolean(record.require_consistent_labels, ctx, `${location}.require_consistent_labels`) });
    case "palette":
      expectKeys(record, ["id", "kind", ...targetKeys, "allowed_tokens", "allow_literals"], ctx, location);
      return Object.freeze({ id, kind, ...selector(record, ctx, location), allowedTokens: uniqueStrings(record.allowed_tokens, ctx, `${location}.allowed_tokens`), allowLiterals: asBoolean(record.allow_literals, ctx, `${location}.allow_literals`) });
    case "external-reference":
      expectKeys(record, ["id", "kind", ...targetKeys, "forbid_external_urls", "forbid_external_images", "forbid_external_uses", "forbid_external_styles", "forbid_external_fonts"], ctx, location);
      return Object.freeze({ id, kind, ...selector(record, ctx, location), forbidExternalUrls: asBoolean(record.forbid_external_urls, ctx, `${location}.forbid_external_urls`), forbidExternalImages: asBoolean(record.forbid_external_images, ctx, `${location}.forbid_external_images`), forbidExternalUses: asBoolean(record.forbid_external_uses, ctx, `${location}.forbid_external_uses`), forbidExternalStyles: asBoolean(record.forbid_external_styles, ctx, `${location}.forbid_external_styles`), forbidExternalFonts: asBoolean(record.forbid_external_fonts, ctx, `${location}.forbid_external_fonts`) });
    case "embedded-content":
      expectKeys(record, ["id", "kind", ...targetKeys, "forbid_embedded_raster", "forbid_embedded_fonts"], ctx, location);
      return Object.freeze({ id, kind, ...selector(record, ctx, location), forbidEmbeddedRaster: asBoolean(record.forbid_embedded_raster, ctx, `${location}.forbid_embedded_raster`), forbidEmbeddedFonts: asBoolean(record.forbid_embedded_fonts, ctx, `${location}.forbid_embedded_fonts`) });
    case "recipe": {
      expectKeys(record, ["id", "kind", "recipe", "family", "verify_provenance", "verify_receipts"], ctx, location);
      const recipe = record.recipe === undefined ? undefined : identifier(record.recipe, ctx, `${location}.recipe`);
      const family = record.family === undefined ? undefined : identifier(record.family, ctx, `${location}.family`);
      if ((recipe === undefined) === (family === undefined)) fail(ctx, "BRAND_QA_INVALID_TARGET", "Recipe case requires exactly one recipe or family.", location);
      return Object.freeze({ id, kind, ...(recipe === undefined ? {} : { recipe }), ...(family === undefined ? {} : { family }), verifyProvenance: asBoolean(record.verify_provenance, ctx, `${location}.verify_provenance`), verifyReceipts: asBoolean(record.verify_receipts, ctx, `${location}.verify_receipts`) });
    }
    case "canvas":
      expectKeys(record, ["id", "kind", ...targetKeys, "require_viewbox", "enforce_minimum_size"], ctx, location);
      return Object.freeze({ id, kind, ...selector(record, ctx, location), requireViewbox: asBoolean(record.require_viewbox, ctx, `${location}.require_viewbox`), enforceMinimumSize: asBoolean(record.enforce_minimum_size, ctx, `${location}.enforce_minimum_size`) });
    case "pixel-bounds":
    case "transparent-bounds":
      expectKeys(record, ["id", "kind", ...visualKeys, "alpha_threshold"], ctx, location);
      return Object.freeze({ id, kind, ...visualCommon(record, ctx, location), alphaThreshold: asInteger(record.alpha_threshold, ctx, `${location}.alpha_threshold`, 0, 255) });
    case "clipping":
      expectKeys(record, ["id", "kind", ...visualKeys, "forbidden_edge_pixels"], ctx, location);
      return Object.freeze({ id, kind, ...visualCommon(record, ctx, location), forbiddenEdgePixels: asInteger(record.forbidden_edge_pixels, ctx, `${location}.forbidden_edge_pixels`, 0, BRAND_QA_MAX_DIMENSION) });
    case "visible-padding": {
      expectKeys(record, ["id", "kind", ...visualKeys, "minimum_padding_px", "minimum_padding_token", "minimum_padding_ratio"], ctx, location);
      const specified = [record.minimum_padding_px, record.minimum_padding_token, record.minimum_padding_ratio].filter((value) => value !== undefined).length;
      if (specified !== 1) fail(ctx, "BRAND_QA_INVALID_THRESHOLD", "Visible-padding requires exactly one minimum threshold.", location);
      return Object.freeze({ id, kind, ...visualCommon(record, ctx, location), ...(record.minimum_padding_px === undefined ? {} : { minimumPaddingPx: asInteger(record.minimum_padding_px, ctx, `${location}.minimum_padding_px`, 0, BRAND_QA_MAX_DIMENSION) }), ...(record.minimum_padding_token === undefined ? {} : { minimumPaddingToken: identifier(record.minimum_padding_token, ctx, `${location}.minimum_padding_token`) }), ...(record.minimum_padding_ratio === undefined ? {} : { minimumPaddingRatio: asInteger(record.minimum_padding_ratio, ctx, `${location}.minimum_padding_ratio`, 0, 1_000_000) }) });
    }
    case "small-size-visibility": {
      expectKeys(record, ["id", "kind", ...visualKeys, "minimum_visible_pixels", "minimum_visible_ratio"], ctx, location);
      const specified = [record.minimum_visible_pixels, record.minimum_visible_ratio].filter((value) => value !== undefined).length;
      if (specified !== 1) fail(ctx, "BRAND_QA_INVALID_THRESHOLD", "Small-size-visibility requires exactly one minimum threshold.", location);
      return Object.freeze({ id, kind, ...visualCommon(record, ctx, location), ...(record.minimum_visible_pixels === undefined ? {} : { minimumVisiblePixels: asInteger(record.minimum_visible_pixels, ctx, `${location}.minimum_visible_pixels`, 0, BRAND_QA_MAX_PIXELS_PER_EVALUATION) }), ...(record.minimum_visible_ratio === undefined ? {} : { minimumVisibleRatio: asInteger(record.minimum_visible_ratio, ctx, `${location}.minimum_visible_ratio`, 0, 1_000_000) }) });
    }
    case "baseline": {
      expectKeys(record, ["id", "kind", ...visualKeys, "baseline_path", "baseline_digest", "renderer_id", "renderer_version", "platform_claim", "canonical_asset_digest", "svg_digest"], ctx, location);
      const common = visualCommon(record, ctx, location);
      if (common.sizes.length !== 1 || common.backgrounds.length !== 1) fail(ctx, "BRAND_QA_BASELINE_MULTIPLICITY", "A baseline case requires exactly one size and one background.", location);
      return Object.freeze({ id, kind, ...common, baselinePath: asString(record.baseline_path, ctx, `${location}.baseline_path`), baselineDigest: digest(record.baseline_digest, ctx, `${location}.baseline_digest`), rendererId: identifier(record.renderer_id, ctx, `${location}.renderer_id`), rendererVersion: asString(record.renderer_version, ctx, `${location}.renderer_version`), platformClaim: asString(record.platform_claim, ctx, `${location}.platform_claim`), canonicalAssetDigest: digest(record.canonical_asset_digest, ctx, `${location}.canonical_asset_digest`), svgDigest: digest(record.svg_digest, ctx, `${location}.svg_digest`) });
    }
    default:
      fail(ctx, "SCHEMA_INVALID_ENUM", `Unknown QA case kind '${kind}'.`, `${location}.kind`);
  }
}

export function isBrandQaVisualCase(value: BrandQaCase): value is BrandQaVisualCase {
  return (BRAND_QA_VISUAL_KINDS as readonly string[]).includes(value.kind);
}

export function parseBrandQaToml(source: string, sourceName = ".tfsb/brand-qa.toml"): Result<BrandQaModel> {
  const ctx = context(sourceName);
  try {
    const byteLength = Buffer.byteLength(source, "utf8");
    if (byteLength > BRAND_QA_MAX_BYTES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `brand-qa.toml exceeds ${BRAND_QA_MAX_BYTES} bytes.`, sourceName);
    if (source.startsWith("\uFEFF")) fail(ctx, "SCHEMA_INVALID_BOM", "UTF-8 BOM is forbidden in brand-qa.toml.");
    let parsed: unknown;
    try { parsed = parseToml(source); }
    catch (error) {
      if (error instanceof TomlError) {
        const message = error.message.toLowerCase();
        fail(ctx, message.includes("duplicate") || message.includes("already defined") || message.includes("redefine") ? "SCHEMA_DUPLICATE_KEY" : "SCHEMA_INVALID_SYNTAX", `TOML parse error: ${error.message}`);
      }
      fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-qa.toml.");
    }
    const root = asRecord(parsed, ctx, "");
    expectKeys(root, ["schema", "schema_version", "profiles", "cases"], ctx, "");
    if (asString(root.schema, ctx, "schema") !== BRAND_QA_SCHEMA_ID) fail(ctx, "SCHEMA_INVALID_ID", `Expected schema '${BRAND_QA_SCHEMA_ID}'.`, "schema");
    if (asInteger(root.schema_version, ctx, "schema_version") !== BRAND_QA_SCHEMA_VERSION) fail(ctx, "SCHEMA_INVALID_VERSION", `Expected schema_version ${BRAND_QA_SCHEMA_VERSION}.`, "schema_version");
    const profileRaw = asArray(root.profiles, ctx, "profiles");
    const caseRaw = asArray(root.cases, ctx, "cases");
    if (profileRaw.length > BRAND_QA_MAX_PROFILES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `QA profiles exceed ${BRAND_QA_MAX_PROFILES}.`, "profiles");
    if (caseRaw.length > BRAND_QA_MAX_CASES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `QA cases exceed ${BRAND_QA_MAX_CASES}.`, "cases");
    const cases = caseRaw.map((entry, index) => parseCase(asRecord(entry, ctx, `cases[${index}]`), ctx, `cases[${index}]`));
    if (new Set(cases.map((entry) => entry.id)).size !== cases.length) fail(ctx, "BRAND_QA_DUPLICATE_CASE", "QA case IDs must be unique.", "cases");
    if (cases.filter(isBrandQaVisualCase).length > BRAND_QA_MAX_VISUAL_CASES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Visual QA cases exceed ${BRAND_QA_MAX_VISUAL_CASES}.`, "cases");
    const caseIds = new Set(cases.map((entry) => entry.id));
    const profiles = profileRaw.map((entry, index): BrandQaProfile => {
      const location = `profiles[${index}]`;
      const record = asRecord(entry, ctx, location);
      expectKeys(record, ["id", "renderer", "formats", "cases"], ctx, location);
      const id = identifier(record.id, ctx, `${location}.id`);
      const renderer = asString(record.renderer, ctx, `${location}.renderer`);
      if (renderer !== "optional" && renderer !== "required") fail(ctx, "SCHEMA_INVALID_ENUM", "Profile renderer must be optional or required.", `${location}.renderer`);
      const formats = uniqueStrings(record.formats, ctx, `${location}.formats`, asString) as BrandQaFormat[];
      if (formats.length === 0 || formats.some((format) => !(BRAND_QA_FORMATS as readonly string[]).includes(format))) fail(ctx, "SCHEMA_INVALID_ENUM", "Profile formats must be a nonempty subset of json, markdown, and html.", `${location}.formats`);
      const selectedCases = uniqueStrings(record.cases, ctx, `${location}.cases`);
      if (selectedCases.length === 0 || selectedCases.length > BRAND_QA_MAX_CASES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Profile cases must contain 1..512 IDs.", `${location}.cases`);
      for (const caseId of selectedCases) if (!caseIds.has(caseId)) fail(ctx, "BRAND_QA_UNKNOWN_CASE", `Profile '${id}' references unknown case '${caseId}'.`, `${location}.cases`);
      return Object.freeze({ id, renderer, formats: Object.freeze([...formats].sort(compareUtf8)), cases: Object.freeze([...selectedCases]) });
    });
    if (new Set(profiles.map((entry) => entry.id)).size !== profiles.length) fail(ctx, "BRAND_QA_DUPLICATE_PROFILE", "QA profile IDs must be unique.", "profiles");
    for (const qaCase of cases) {
      if (qaCase.kind !== "baseline") continue;
      const owners = profiles.filter((profile) => profile.cases.includes(qaCase.id));
      if (owners.length !== 1) fail(ctx, "BRAND_QA_BASELINE_OWNERSHIP", `Baseline case '${qaCase.id}' must belong to exactly one profile.`, "profiles");
      const expectedPath = `.tfsb/brand-baselines/${owners[0]!.id}/${qaCase.id}.png`;
      if (qaCase.baselinePath !== expectedPath) fail(ctx, "BRAND_QA_BASELINE_PATH", `Baseline path must equal '${expectedPath}'.`, "cases");
    }
    cases.sort((a, b) => compareUtf8(a.id, b.id));
    profiles.sort((a, b) => compareUtf8(a.id, b.id));
    return ok(Object.freeze({ schema: BRAND_QA_SCHEMA_ID, schemaVersion: BRAND_QA_SCHEMA_VERSION, profiles: Object.freeze(profiles), cases: Object.freeze(cases) }));
  } catch (error) {
    return fromCaught(error, ctx, "SCHEMA_INVALID_SYNTAX", "Failed to validate brand-qa.toml.");
  }
}

export function toBrandQaCanonicalDto(model: BrandQaModel): BrandQaModel {
  return JSON.parse(encodeCanonicalJson(model)) as BrandQaModel;
}

function q(value: string): string { return JSON.stringify(value); }
function stringArray(values: readonly string[]): string { return `[${values.map(q).join(", ")}]`; }

export function serializeBrandQaToml(model: BrandQaModel): string {
  const lines = [`schema = ${q(BRAND_QA_SCHEMA_ID)}`, `schema_version = ${BRAND_QA_SCHEMA_VERSION}`, ""];
  for (const profile of [...model.profiles].sort((a, b) => compareUtf8(a.id, b.id))) {
    lines.push("[[profiles]]", `id = ${q(profile.id)}`, `renderer = ${q(profile.renderer)}`, `formats = ${stringArray(profile.formats)}`, `cases = ${stringArray(profile.cases)}`, "");
  }
  for (const qaCase of [...model.cases].sort((a, b) => compareUtf8(a.id, b.id))) {
    lines.push("[[cases]]", `id = ${q(qaCase.id)}`, `kind = ${q(qaCase.kind)}`);
    if ("asset" in qaCase && qaCase.asset !== undefined) lines.push(`asset = ${q(qaCase.asset)}`);
    if ("family" in qaCase && qaCase.family !== undefined) lines.push(`family = ${q(qaCase.family)}`);
    if ("role" in qaCase && qaCase.role !== undefined) lines.push(`role = ${q(qaCase.role)}`);
    if ("variant" in qaCase && qaCase.variant !== undefined) lines.push(`variant = ${q(qaCase.variant)}`);
    if (qaCase.kind === "inventory" && qaCase.roles !== undefined) lines.push(`roles = ${stringArray(qaCase.roles)}`);
    if (qaCase.kind === "accessibility") lines.push(`require_consistent_labels = ${qaCase.requireConsistentLabels}`);
    if (qaCase.kind === "palette") lines.push(`allowed_tokens = ${stringArray(qaCase.allowedTokens)}`, `allow_literals = ${qaCase.allowLiterals}`);
    if (qaCase.kind === "external-reference") lines.push(`forbid_external_urls = ${qaCase.forbidExternalUrls}`, `forbid_external_images = ${qaCase.forbidExternalImages}`, `forbid_external_uses = ${qaCase.forbidExternalUses}`, `forbid_external_styles = ${qaCase.forbidExternalStyles}`, `forbid_external_fonts = ${qaCase.forbidExternalFonts}`);
    if (qaCase.kind === "embedded-content") lines.push(`forbid_embedded_raster = ${qaCase.forbidEmbeddedRaster}`, `forbid_embedded_fonts = ${qaCase.forbidEmbeddedFonts}`);
    if (qaCase.kind === "recipe") { if (qaCase.recipe !== undefined) lines.push(`recipe = ${q(qaCase.recipe)}`); lines.push(`verify_provenance = ${qaCase.verifyProvenance}`, `verify_receipts = ${qaCase.verifyReceipts}`); }
    if (qaCase.kind === "canvas") lines.push(`require_viewbox = ${qaCase.requireViewbox}`, `enforce_minimum_size = ${qaCase.enforceMinimumSize}`);
    if (isBrandQaVisualCase(qaCase)) {
      lines.push(`sizes = [${qaCase.sizes.map(([width, height]) => `[${width}, ${height}]`).join(", ")}]`, `backgrounds = ${stringArray(qaCase.backgrounds)}`);
      if (qaCase.kind === "pixel-bounds" || qaCase.kind === "transparent-bounds") lines.push(`alpha_threshold = ${qaCase.alphaThreshold}`);
      if (qaCase.kind === "clipping") lines.push(`forbidden_edge_pixels = ${qaCase.forbiddenEdgePixels}`);
      if (qaCase.kind === "visible-padding") {
        if (qaCase.minimumPaddingPx !== undefined) lines.push(`minimum_padding_px = ${qaCase.minimumPaddingPx}`);
        if (qaCase.minimumPaddingToken !== undefined) lines.push(`minimum_padding_token = ${q(qaCase.minimumPaddingToken)}`);
        if (qaCase.minimumPaddingRatio !== undefined) lines.push(`minimum_padding_ratio = ${qaCase.minimumPaddingRatio}`);
      }
      if (qaCase.kind === "small-size-visibility") {
        if (qaCase.minimumVisiblePixels !== undefined) lines.push(`minimum_visible_pixels = ${qaCase.minimumVisiblePixels}`);
        if (qaCase.minimumVisibleRatio !== undefined) lines.push(`minimum_visible_ratio = ${qaCase.minimumVisibleRatio}`);
      }
      if (qaCase.kind === "baseline") lines.push(`baseline_path = ${q(qaCase.baselinePath)}`, `baseline_digest = ${q(qaCase.baselineDigest)}`, `renderer_id = ${q(qaCase.rendererId)}`, `renderer_version = ${q(qaCase.rendererVersion)}`, `platform_claim = ${q(qaCase.platformClaim)}`, `canonical_asset_digest = ${q(qaCase.canonicalAssetDigest)}`, `svg_digest = ${q(qaCase.svgDigest)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function computeBrandQaDigest(model: BrandQaModel): Sha256Digest {
  return computeSha256(Buffer.from(BRAND_QA_DIGEST_BASIS + encodeCanonicalJson(toBrandQaCanonicalDto(model)), "utf8"));
}
