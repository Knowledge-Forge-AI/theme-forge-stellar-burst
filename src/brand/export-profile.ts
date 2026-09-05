import { parse as parseToml, TomlError } from "smol-toml";

import { fail, fromCaught, ok, type DiagnosticContext } from "../diagnostics.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import type { Result } from "../types.js";
import type { AnyNormalizedAsset } from "../schema-dispatch.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import { isValidBrandRole, type BrandModel } from "./brand-schema.js";
import type { BrandTokensModel } from "./tokens.js";

export const BRAND_EXPORTS_SCHEMA_ID = "tfsb.brand-exports" as const;
export const BRAND_EXPORTS_SCHEMA_VERSION = 1 as const;
export const BRAND_EXPORT_ADAPTER_ID = "resvg-png-v1" as const;
export const BRAND_EXPORTS_MAX_BYTES = 1_048_576;
export const BRAND_EXPORTS_MAX_PROFILES = 32;
export const BRAND_EXPORTS_MAX_OUTPUTS = 128;
export const BRAND_EXPORT_MAX_DIMENSION = 16_384;
export const BRAND_EXPORT_MAX_PIXELS = 16_777_216;
export const BRAND_EXPORT_MAX_DECODED_RGBA_BYTES = 256 * 1_048_576;
export const BRAND_EXPORT_MAX_PNG_BYTES = 32 * 1_048_576;
export const BRAND_EXPORT_MAX_STAGED_PNG_BYTES = 256 * 1_048_576;
export const BRAND_EXPORTS_DIGEST_BASIS = "tfsb.brand-exports-v1\n" as const;
export const BRAND_EXPORT_PROFILE_DIGEST_BASIS = "tfsb.brand-export-profile-v1\n" as const;
export const BRAND_EXPORT_OUTPUT_DIGEST_BASIS = "tfsb.brand-export-output-v1\n" as const;

export type BrandExportPurpose = "png" | "apple-touch-icon" | "pwa-icon" | "avatar" | "social-card";
export type BrandExportAlpha = "straight" | "opaque";

export interface BrandExportOutput {
  readonly id: string;
  readonly purpose: BrandExportPurpose;
  readonly asset?: string;
  readonly family?: string;
  readonly role?: string;
  readonly variant?: string;
  readonly destination: string;
  readonly width: number;
  readonly height: number;
  readonly fit: "contain-pad";
  readonly background?: "transparent" | `#${string}`;
  readonly backgroundToken?: string;
  readonly colorSpace: "srgb";
  readonly alpha: BrandExportAlpha;
}

export interface BrandExportProfile {
  readonly id: string;
  readonly adapter: typeof BRAND_EXPORT_ADAPTER_ID;
  readonly outputs: readonly BrandExportOutput[];
}

export interface BrandExportsModel {
  readonly schema: typeof BRAND_EXPORTS_SCHEMA_ID;
  readonly schemaVersion: typeof BRAND_EXPORTS_SCHEMA_VERSION;
  readonly profiles: readonly BrandExportProfile[];
}

type UnknownRecord = Record<string, unknown>;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RGBA = /^#[0-9A-F]{8}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const PURPOSES = new Set<BrandExportPurpose>(["png", "apple-touch-icon", "pwa-icon", "avatar", "social-card"]);

function context(source?: string): DiagnosticContext {
  return { operation: "parse", domain: "brand", ...(source === undefined ? {} : { source }) };
}

function record(value: unknown, ctx: DiagnosticContext, location: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML table.", location);
  return value as UnknownRecord;
}

function array(value: unknown, ctx: DiagnosticContext, location: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML array.", location);
  return value;
}

function string(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a string.", location);
  return value;
}

function integer(value: unknown, ctx: DiagnosticContext, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a safe integer.", location);
  if (value < 1 || value > BRAND_EXPORT_MAX_DIMENSION) fail(ctx, "SCHEMA_INVALID_RANGE", `Expected an integer from 1 through ${BRAND_EXPORT_MAX_DIMENSION}.`, location);
  return value;
}

function keys(value: UnknownRecord, allowed: readonly string[], ctx: DiagnosticContext, location: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(ctx, "SCHEMA_UNKNOWN_KEY", `Unknown key '${key}'.`, location === "" ? key : `${location}.${key}`);
}

function identifier(value: unknown, ctx: DiagnosticContext, location: string): string {
  const text = string(value, ctx, location);
  if (Buffer.byteLength(text, "utf8") > 64 || !ID.test(text)) fail(ctx, "SCHEMA_INVALID_IDENTIFIER", "Expected a 1..64 byte lowercase kebab identifier.", location);
  return text;
}

export function validateRasterDestination(value: unknown, location = "destination"): string {
  const ctx = context();
  const text = string(value, ctx, location);
  if (text !== text.normalize("NFC") || text.length === 0 || Buffer.byteLength(text, "utf8") > 4096 || text.includes("\\") || text.includes("\0") || /[\x00-\x1f\x7f<>:"|?*${}]/.test(text) || text.startsWith("~") || text.startsWith("/") || text.startsWith("//") || /^[A-Za-z]:/.test(text) || !text.toLowerCase().endsWith(".png")) {
    fail(ctx, "RASTER_DESTINATION_INVALID", "Destination must be a bounded NFC project-relative .png path using '/'.", location);
  }
  for (const part of text.split("/")) {
    if (part === "" || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255 || part.endsWith(" ") || part.endsWith(".") || WINDOWS_RESERVED.test(part)) fail(ctx, "RASTER_DESTINATION_INVALID", "Destination contains an unsafe or nonportable component.", location);
  }
  if (isProtectedRasterDestination(text)) fail(ctx, "RASTER_DESTINATION_PROTECTED", "Raster destination targets a protected project path.", location);
  return text;
}

export function isProtectedRasterDestination(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === ".git" || lower.startsWith(".git/") || lower === ".tfsb" || lower.startsWith(".tfsb/") || lower === ".tfsb-preview" || lower.startsWith(".tfsb-preview/") || lower === "node_modules" || lower.startsWith("node_modules/") || lower.startsWith(".tfsb-raster-transaction-") || /(?:^|\/)\..+\.tfsb-raster-(?:stage|backup)-/.test(lower);
}

function portableKey(path: string): string { return path.normalize("NFC").toLowerCase(); }
function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }

function parseOutput(value: unknown, ctx: DiagnosticContext, profileIndex: number, outputIndex: number): BrandExportOutput {
  const loc = `profiles[${profileIndex}].outputs[${outputIndex}]`;
  const out = record(value, ctx, loc);
  keys(out, ["id", "purpose", "asset", "family", "role", "variant", "destination", "width", "height", "fit", "background", "background_token", "color_space", "alpha"], ctx, loc);
  const id = identifier(out.id, ctx, `${loc}.id`);
  const purposeText = string(out.purpose, ctx, `${loc}.purpose`);
  if (!PURPOSES.has(purposeText as BrandExportPurpose)) fail(ctx, "SCHEMA_INVALID_ENUM", "Unknown PNG export purpose.", `${loc}.purpose`);
  const hasAsset = out.asset !== undefined;
  const triple = Number(out.family !== undefined) + Number(out.role !== undefined) + Number(out.variant !== undefined);
  if (Number(hasAsset) + Number(triple > 0) !== 1 || (triple !== 0 && triple !== 3)) fail(ctx, "BRAND_EXPORT_INVALID_SELECTOR", "Each output must select exactly asset or family+role+variant.", loc);
  const asset = hasAsset ? identifier(out.asset, ctx, `${loc}.asset`) : undefined;
  const family = triple === 3 ? identifier(out.family, ctx, `${loc}.family`) : undefined;
  const role = triple === 3 ? string(out.role, ctx, `${loc}.role`) : undefined;
  if (role !== undefined && !isValidBrandRole(role)) fail(ctx, "SCHEMA_INVALID_ROLE", `Invalid brand role '${role}'.`, `${loc}.role`);
  const variant = triple === 3 ? identifier(out.variant, ctx, `${loc}.variant`) : undefined;
  const destination = validateRasterDestination(out.destination, `${loc}.destination`);
  const width = integer(out.width, ctx, `${loc}.width`);
  const height = integer(out.height, ctx, `${loc}.height`);
  if (width * height > BRAND_EXPORT_MAX_PIXELS) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Raster output exceeds ${BRAND_EXPORT_MAX_PIXELS} pixels.`, loc);
  if (string(out.fit, ctx, `${loc}.fit`) !== "contain-pad") fail(ctx, "SCHEMA_INVALID_ENUM", "fit must be 'contain-pad'.", `${loc}.fit`);
  const hasBackground = out.background !== undefined;
  const hasBackgroundToken = out.background_token !== undefined;
  if (Number(hasBackground) + Number(hasBackgroundToken) !== 1) fail(ctx, "BRAND_EXPORT_INVALID_BACKGROUND", "Use exactly background or background_token.", loc);
  let background: "transparent" | `#${string}` | undefined;
  let backgroundToken: string | undefined;
  if (hasBackground) {
    const text = string(out.background, ctx, `${loc}.background`);
    if (text !== "transparent" && !RGBA.test(text)) fail(ctx, "BRAND_EXPORT_INVALID_BACKGROUND", "background must be transparent or canonical #RRGGBBAA.", `${loc}.background`);
    background = text as "transparent" | `#${string}`;
  } else backgroundToken = identifier(out.background_token, ctx, `${loc}.background_token`);
  if (string(out.color_space, ctx, `${loc}.color_space`) !== "srgb") fail(ctx, "SCHEMA_INVALID_ENUM", "color_space must be 'srgb'.", `${loc}.color_space`);
  const alphaText = string(out.alpha, ctx, `${loc}.alpha`);
  if (alphaText !== "straight" && alphaText !== "opaque") fail(ctx, "SCHEMA_INVALID_ENUM", "alpha must be straight or opaque.", `${loc}.alpha`);
  if (alphaText === "opaque" && background === "transparent") fail(ctx, "BRAND_EXPORT_INVALID_BACKGROUND", "opaque alpha requires a fully opaque background.", `${loc}.background`);
  if (alphaText === "opaque" && background !== undefined && background.slice(-2) !== "FF") fail(ctx, "BRAND_EXPORT_INVALID_BACKGROUND", "opaque alpha requires #RRGGBBFF or an opaque color token.", `${loc}.background`);
  return Object.freeze({ id, purpose: purposeText as BrandExportPurpose, ...(asset === undefined ? { family: family!, role: role!, variant: variant! } : { asset }), destination, width, height, fit: "contain-pad", ...(background === undefined ? { backgroundToken: backgroundToken! } : { background }), colorSpace: "srgb", alpha: alphaText });
}

export function parseBrandExportsToml(source: string, sourceName = ".tfsb/brand-exports.toml"): Result<BrandExportsModel> {
  const ctx = context(sourceName);
  try {
    if (Buffer.byteLength(source, "utf8") > BRAND_EXPORTS_MAX_BYTES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `brand-exports.toml exceeds ${BRAND_EXPORTS_MAX_BYTES} bytes.`, sourceName);
    if (source.startsWith("\uFEFF")) fail(ctx, "SCHEMA_INVALID_BOM", "UTF-8 BOM is forbidden.", sourceName);
    let parsed: unknown;
    try { parsed = parseToml(source); }
    catch (error) {
      if (error instanceof TomlError) fail(ctx, /duplicate|already defined|redefine/i.test(error.message) ? "SCHEMA_DUPLICATE_KEY" : "SCHEMA_INVALID_SYNTAX", `TOML parse error: ${error.message}`);
      throw error;
    }
    const root = record(parsed, ctx, "");
    keys(root, ["schema", "schema_version", "profiles"], ctx, "");
    if (string(root.schema, ctx, "schema") !== BRAND_EXPORTS_SCHEMA_ID) fail(ctx, "SCHEMA_INVALID_ID", `Expected schema '${BRAND_EXPORTS_SCHEMA_ID}'.`, "schema");
    if (integer(root.schema_version, ctx, "schema_version") !== 1) fail(ctx, "SCHEMA_INVALID_VERSION", "Unsupported brand export schema version.", "schema_version");
    const rawProfiles = array(root.profiles, ctx, "profiles");
    if (rawProfiles.length < 1 || rawProfiles.length > BRAND_EXPORTS_MAX_PROFILES) fail(ctx, "SCHEMA_INVALID_RANGE", "brand-exports.toml must contain 1..32 profiles.", "profiles");
    let totalOutputs = 0;
    const profiles = rawProfiles.map((value, pi) => {
      const loc = `profiles[${pi}]`, profile = record(value, ctx, loc);
      keys(profile, ["id", "adapter", "outputs"], ctx, loc);
      const id = identifier(profile.id, ctx, `${loc}.id`);
      if (string(profile.adapter, ctx, `${loc}.adapter`) !== BRAND_EXPORT_ADAPTER_ID) fail(ctx, "SCHEMA_INVALID_ENUM", `adapter must be '${BRAND_EXPORT_ADAPTER_ID}'.`, `${loc}.adapter`);
      const rawOutputs = array(profile.outputs, ctx, `${loc}.outputs`);
      if (rawOutputs.length < 1 || rawOutputs.length > BRAND_EXPORTS_MAX_OUTPUTS) fail(ctx, "SCHEMA_INVALID_RANGE", "A profile must contain 1..128 outputs.", `${loc}.outputs`);
      totalOutputs += rawOutputs.length;
      const outputs = rawOutputs.map((entry, oi) => parseOutput(entry, ctx, pi, oi)).sort((a, b) => compareUtf8(a.id, b.id));
      if (new Set(outputs.map((entry) => entry.id)).size !== outputs.length) fail(ctx, "SCHEMA_DUPLICATE_KEY", `Profile '${id}' contains duplicate output IDs.`, `${loc}.outputs`);
      return Object.freeze({ id, adapter: BRAND_EXPORT_ADAPTER_ID, outputs: Object.freeze(outputs) });
    }).sort((a, b) => compareUtf8(a.id, b.id));
    if (totalOutputs > BRAND_EXPORTS_MAX_OUTPUTS) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "brand-exports.toml exceeds 128 total outputs.", "profiles");
    if (new Set(profiles.map((entry) => entry.id)).size !== profiles.length) fail(ctx, "SCHEMA_DUPLICATE_KEY", "Export profile IDs must be unique.", "profiles");
    const destinations: { path: string; location: string }[] = [];
    for (const profile of profiles) {
      let rgbaBytes = 0;
      for (const output of profile.outputs) {
        const location = `${profile.id}/${output.id}`;
        const key = portableKey(output.destination);
        for (const existing of destinations) if (overlaps(key, existing.path)) fail(ctx, "RASTER_OWNERSHIP_CONFLICT", `Raster destinations '${existing.location}' and '${location}' collide or overlap.`, output.destination);
        destinations.push({ path: key, location });
        rgbaBytes += output.width * output.height * 4;
      }
      if (rgbaBytes > BRAND_EXPORT_MAX_DECODED_RGBA_BYTES) fail(ctx, "RESOURCE_LIMIT_EXCEEDED", `Export profile '${profile.id}' exceeds the 256 MiB aggregate decoded RGBA limit.`, "profiles");
    }
    return ok(Object.freeze({ schema: BRAND_EXPORTS_SCHEMA_ID, schemaVersion: BRAND_EXPORTS_SCHEMA_VERSION, profiles: Object.freeze(profiles) }));
  } catch (error) {
    return fromCaught(error, ctx, "SCHEMA_INVALID_SYNTAX", "Failed to validate brand-exports.toml.", (caught) => caught instanceof TomlError);
  }
}

function q(value: string): string { return JSON.stringify(value).replace(/\u007f/g, "\\u007F"); }

export function serializeBrandExportsToml(model: BrandExportsModel): string {
  const lines = [`schema = ${q(BRAND_EXPORTS_SCHEMA_ID)}`, "schema_version = 1"];
  for (const profile of [...model.profiles].sort((a, b) => compareUtf8(a.id, b.id))) {
    lines.push("", "[[profiles]]", `id = ${q(profile.id)}`, `adapter = ${q(BRAND_EXPORT_ADAPTER_ID)}`);
    for (const output of [...profile.outputs].sort((a, b) => compareUtf8(a.id, b.id))) {
      lines.push("", "[[profiles.outputs]]", `id = ${q(output.id)}`, `purpose = ${q(output.purpose)}`);
      if (output.asset !== undefined) lines.push(`asset = ${q(output.asset)}`);
      else lines.push(`family = ${q(output.family!)}`, `role = ${q(output.role!)}`, `variant = ${q(output.variant!)}`);
      lines.push(`destination = ${q(output.destination)}`, `width = ${output.width}`, `height = ${output.height}`, 'fit = "contain-pad"');
      if (output.background !== undefined) lines.push(`background = ${q(output.background)}`);
      else lines.push(`background_token = ${q(output.backgroundToken!)}`);
      lines.push('color_space = "srgb"', `alpha = ${q(output.alpha)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function toBrandExportProfileCanonicalDto(profile: BrandExportProfile): Readonly<{ profileId: string; adapter: string }> {
  return Object.freeze({ profileId: profile.id, adapter: profile.adapter });
}

export function toBrandExportOutputCanonicalDto(output: BrandExportOutput): Readonly<Record<string, unknown>> {
  return Object.freeze({ outputId: output.id, purpose: output.purpose, ...(output.asset === undefined ? { family: output.family, role: output.role, variant: output.variant } : { asset: output.asset }), destination: output.destination, width: output.width, height: output.height, fit: output.fit, ...(output.background === undefined ? { background_token: output.backgroundToken } : { background: output.background }), color_space: output.colorSpace, alpha: output.alpha });
}

export function computeBrandExportsDomainDigest(model: BrandExportsModel): Sha256Digest {
  return computeSha256(Buffer.from(BRAND_EXPORTS_DIGEST_BASIS + encodeCanonicalJson(model), "utf8"));
}

export function computeRawBrandExportsFileDigest(model: BrandExportsModel): Sha256Digest {
  return computeSha256(Buffer.from(serializeBrandExportsToml(model), "utf8"));
}

export function computeBrandExportProfileDigest(profile: BrandExportProfile): Sha256Digest {
  return computeSha256(Buffer.from(BRAND_EXPORT_PROFILE_DIGEST_BASIS + encodeCanonicalJson(toBrandExportProfileCanonicalDto(profile)), "utf8"));
}

export function computeBrandExportOutputDigest(output: BrandExportOutput): Sha256Digest {
  return computeSha256(Buffer.from(BRAND_EXPORT_OUTPUT_DIGEST_BASIS + encodeCanonicalJson(toBrandExportOutputCanonicalDto(output)), "utf8"));
}

export function validateBrandExportSemantics(model: BrandExportsModel, brand: BrandModel, tokens: BrandTokensModel | undefined, assets: ReadonlyMap<string, AnyNormalizedAsset>, ctx: DiagnosticContext): void {
  for (const profile of model.profiles) for (const output of profile.outputs) {
    if (output.asset !== undefined) {
      if (!assets.has(output.asset)) fail(ctx, "BRAND_EXPORT_UNKNOWN_ASSET", `Export '${profile.id}/${output.id}' references unknown asset '${output.asset}'.`, ".tfsb/brand-exports.toml");
    } else {
      const matches = brand.bindings.filter((binding) => binding.family === output.family && binding.role === output.role && binding.variant === output.variant);
      if (matches.length !== 1 || !assets.has(matches[0]!.asset)) fail(ctx, "BRAND_EXPORT_SELECTOR_AMBIGUOUS", `Export '${profile.id}/${output.id}' must resolve exactly one available family/role/variant binding.`, ".tfsb/brand-exports.toml");
    }
    if (output.backgroundToken !== undefined) {
      const token = tokens?.colors.find((entry) => entry.id === output.backgroundToken);
      if (token === undefined) fail(ctx, "BRAND_EXPORT_BACKGROUND_TOKEN_INVALID", `Export '${profile.id}/${output.id}' requires available color token '${output.backgroundToken}'.`, ".tfsb/brand-exports.toml");
      if (output.alpha === "opaque" && token.value.slice(-2) !== "FF") fail(ctx, "BRAND_EXPORT_BACKGROUND_TOKEN_INVALID", `Opaque export '${profile.id}/${output.id}' requires a fully opaque color token.`, ".tfsb/brand-exports.toml");
    }
  }
}
