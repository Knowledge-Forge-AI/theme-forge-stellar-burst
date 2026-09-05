import { parse as parseToml, TomlError } from "smol-toml";

import { fail, fromCaught, ok, type DiagnosticContext } from "../diagnostics.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import type { Result } from "../types.js";
import { encodeCanonicalJson } from "./brand-digests.js";

export const BRAND_TOKENS_SCHEMA_ID = "tfsb.brand-tokens" as const;
export const BRAND_TOKENS_SCHEMA_VERSION = 1 as const;
export const BRAND_TOKENS_DIGEST_BASIS = "tfsb.brand-tokens-v1\n" as const;
export const BRAND_TOKENS_MAX_BYTES = 1048576; // 1 MiB
export const BRAND_TOKENS_MAX_COUNT = 256;
export const BRAND_TOKENS_MAX_REFERENCES = 1024;
export const BRAND_TOKENS_MAX_DEPTH = 8;
export const BRAND_TOKENS_MIN_GRADIENT_STOPS = 2;
export const BRAND_TOKENS_MAX_GRADIENT_STOPS = 16;

export const BRAND_GRADIENT_UNITS = [
  "object-bounding-box-millionth",
  "user-space",
] as const;
export type BrandGradientUnits = (typeof BRAND_GRADIENT_UNITS)[number];

export const BRAND_DIMENSION_UNITS = [
  "px",
  "percent-millionth",
  "viewbox-millionth",
] as const;
export type BrandDimensionUnits = (typeof BRAND_DIMENSION_UNITS)[number];

export interface BrandColorToken {
  readonly id: string;
  readonly type: "color";
  readonly value: string;
}

export interface BrandGradientStop {
  readonly offset: number;
  readonly colorToken?: string;
  readonly color?: string;
}

export interface BrandGradientToken {
  readonly id: string;
  readonly type: "gradient";
  readonly kind: "linear";
  readonly units: BrandGradientUnits;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly stops: readonly BrandGradientStop[];
}

export interface BrandDimensionToken {
  readonly id: string;
  readonly type: "dimension";
  readonly unit: BrandDimensionUnits;
  readonly value: number;
}

export interface BrandOpacityToken {
  readonly id: string;
  readonly type: "opacity";
  readonly value: number;
}

export type BrandToken =
  | BrandColorToken
  | BrandGradientToken
  | BrandDimensionToken
  | BrandOpacityToken;

export interface BrandTokensModel {
  readonly schema: typeof BRAND_TOKENS_SCHEMA_ID;
  readonly schemaVersion: typeof BRAND_TOKENS_SCHEMA_VERSION;
  readonly colors: readonly BrandColorToken[];
  readonly gradients: readonly BrandGradientToken[];
  readonly dimensions: readonly BrandDimensionToken[];
  readonly opacities: readonly BrandOpacityToken[];
}

export interface BrandTokensCanonicalDto {
  readonly colors: readonly {
    readonly id: string;
    readonly value: string;
  }[];
  readonly dimensions: readonly {
    readonly id: string;
    readonly unit: string;
    readonly value: number;
  }[];
  readonly gradients: readonly {
    readonly id: string;
    readonly kind: "linear";
    readonly stops: readonly {
      readonly color?: string;
      readonly colorToken?: string;
      readonly offset: number;
    }[];
    readonly units: string;
    readonly x1: number;
    readonly x2: number;
    readonly y1: number;
    readonly y2: number;
  }[];
  readonly opacities: readonly {
    readonly id: string;
    readonly value: number;
  }[];
  readonly schema: typeof BRAND_TOKENS_SCHEMA_ID;
  readonly schemaVersion: typeof BRAND_TOKENS_SCHEMA_VERSION;
}

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const COLOR_HEX_REGEX = /^#[0-9A-F]{8}$/;

function context(source?: string): DiagnosticContext {
  return { operation: "parse", domain: "project-toml", ...(source === undefined ? {} : { source }) };
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
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML table.", location);
  }
  return value as UnknownRecord;
}

function asArray(value: unknown, ctx: DiagnosticContext, location: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML array.", location);
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

export function parseBrandTokensToml(
  source: string,
  sourceName = ".tfsb/brand-tokens.toml",
): Result<BrandTokensModel> {
  const ctx = context(sourceName);
  try {
    const byteLength = Buffer.byteLength(source, "utf8");
    if (byteLength > BRAND_TOKENS_MAX_BYTES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "brand-tokens.toml size " + byteLength + " bytes exceeds limit " + BRAND_TOKENS_MAX_BYTES + " bytes.",
        sourceName,
      );
    }

    if (source.startsWith("\uFEFF")) {
      fail(ctx, "SCHEMA_INVALID_BOM", "UTF-8 BOM is forbidden in brand-tokens.toml.");
    }

    let parsed: unknown;
    try {
      parsed = parseToml(source);
    } catch (error) {
      if (error instanceof TomlError) {
        const msg = error.message.toLowerCase();
        const code =
          msg.includes("duplicate") || msg.includes("already defined") || msg.includes("redefine")
            ? "SCHEMA_DUPLICATE_KEY"
            : "SCHEMA_INVALID_SYNTAX";
        fail(ctx, code, "TOML parse error: " + error.message);
      }
      fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-tokens.toml.");
    }

    const root = asRecord(parsed, ctx, "");
    expectKeys(root, ["schema", "schema_version", "colors", "gradients", "dimensions", "opacities"], ctx, "");

    const schema = asString(root.schema, ctx, "schema");
    if (schema !== BRAND_TOKENS_SCHEMA_ID) {
      fail(ctx, "SCHEMA_INVALID_ID", "Expected schema '" + BRAND_TOKENS_SCHEMA_ID + "', got '" + schema + "'.", "schema");
    }

    const schemaVersion = asInteger(root.schema_version, ctx, "schema_version");
    if (schemaVersion !== BRAND_TOKENS_SCHEMA_VERSION) {
      fail(
        ctx,
        "SCHEMA_INVALID_VERSION",
        "Expected schema_version " + BRAND_TOKENS_SCHEMA_VERSION + ", got " + schemaVersion + ".",
        "schema_version",
      );
    }

    const seenTokenIds = new Set<string>();
    const colorTokenIds = new Set<string>();

    // 1. Colors
    const colorsRaw = root.colors === undefined ? [] : asArray(root.colors, ctx, "colors");
    const colors: BrandColorToken[] = [];
    for (let i = 0; i < colorsRaw.length; i++) {
      const loc = "colors[" + i + "]";
      const rec = asRecord(colorsRaw[i], ctx, loc);
      expectKeys(rec, ["id", "value"], ctx, loc);

      const id = validateIdentifier(rec.id, ctx, loc + ".id");
      if (seenTokenIds.has(id)) {
        fail(ctx, "BRAND_DUPLICATE_TOKEN", "Duplicate token id '" + id + "'.", loc + ".id");
      }
      seenTokenIds.add(id);
      colorTokenIds.add(id);

      const val = asString(rec.value, ctx, loc + ".value");
      if (!COLOR_HEX_REGEX.test(val)) {
        fail(
          ctx,
          "BRAND_INVALID_COLOR_VALUE",
          "Color token '" + id + "' value '" + val + "' must be 8 uppercase hex digits '#RRGGBBAA'.",
          loc + ".value",
        );
      }

      colors.push(Object.freeze({ id, type: "color", value: val }));
    }

    // 2. Gradients
    const gradientsRaw = root.gradients === undefined ? [] : asArray(root.gradients, ctx, "gradients");
    const gradients: BrandGradientToken[] = [];
    let totalReferencesCount = 0;

    for (let i = 0; i < gradientsRaw.length; i++) {
      const loc = "gradients[" + i + "]";
      const rec = asRecord(gradientsRaw[i], ctx, loc);
      expectKeys(rec, ["id", "kind", "units", "x1", "y1", "x2", "y2", "stops"], ctx, loc);

      const id = validateIdentifier(rec.id, ctx, loc + ".id");
      if (seenTokenIds.has(id)) {
        fail(ctx, "BRAND_DUPLICATE_TOKEN", "Duplicate token id '" + id + "'.", loc + ".id");
      }
      seenTokenIds.add(id);

      const kind = asString(rec.kind, ctx, loc + ".kind");
      if (kind !== "linear") {
        fail(ctx, "SCHEMA_INVALID_ENUM", "Gradient kind must be 'linear', got '" + kind + "'.", loc + ".kind");
      }

      const unitsStr = asString(rec.units, ctx, loc + ".units");
      if (!(BRAND_GRADIENT_UNITS as readonly string[]).includes(unitsStr)) {
        fail(
          ctx,
          "SCHEMA_INVALID_ENUM",
          "Gradient units '" + unitsStr + "' is invalid; expected one of " + BRAND_GRADIENT_UNITS.join(", ") + ".",
          loc + ".units",
        );
      }
      const units = unitsStr as BrandGradientUnits;
      const coordinate = (value: unknown, field: string): number =>
        units === "object-bounding-box-millionth"
          ? asInteger(value, ctx, loc + "." + field, 0, 1000000)
          : asInteger(value, ctx, loc + "." + field);
      const x1 = coordinate(rec.x1, "x1");
      const y1 = coordinate(rec.y1, "y1");
      const x2 = coordinate(rec.x2, "x2");
      const y2 = coordinate(rec.y2, "y2");

      const stopsRaw = asArray(rec.stops, ctx, loc + ".stops");
      if (stopsRaw.length < BRAND_TOKENS_MIN_GRADIENT_STOPS || stopsRaw.length > BRAND_TOKENS_MAX_GRADIENT_STOPS) {
        fail(
          ctx,
          "RESOURCE_LIMIT_EXCEEDED",
          "Gradient stops count " + stopsRaw.length + " must be between " + BRAND_TOKENS_MIN_GRADIENT_STOPS + " and " + BRAND_TOKENS_MAX_GRADIENT_STOPS + ".",
          loc + ".stops",
        );
      }

      const stops: BrandGradientStop[] = [];
      let previousOffset = -1;

      for (let s = 0; s < stopsRaw.length; s++) {
        const sLoc = loc + ".stops[" + s + "]";
        const stopRec = asRecord(stopsRaw[s], ctx, sLoc);
        expectKeys(stopRec, ["offset", "color_token", "color"], ctx, sLoc);

        const offset = asInteger(stopRec.offset, ctx, sLoc + ".offset", 0, 1000000);
        if (offset < previousOffset) {
          fail(
            ctx,
            "BRAND_INVALID_GRADIENT_STOPS",
            "Gradient stop offsets must be nondecreasing; offset " + offset + " is less than previous " + previousOffset + ".",
            sLoc + ".offset",
          );
        }
        previousOffset = offset;

        const hasColorToken = stopRec.color_token !== undefined;
        const hasColor = stopRec.color !== undefined;

        if (hasColorToken && hasColor) {
          fail(
            ctx,
            "BRAND_INVALID_GRADIENT_STOP",
            "Gradient stop cannot specify both 'color_token' and 'color'.",
            sLoc,
          );
        }
        if (!hasColorToken && !hasColor) {
          fail(
            ctx,
            "BRAND_INVALID_GRADIENT_STOP",
            "Gradient stop must specify either 'color_token' or 'color'.",
            sLoc,
          );
        }

        let colorToken: string | undefined;
        let color: string | undefined;

        if (hasColorToken) {
          colorToken = validateIdentifier(stopRec.color_token, ctx, sLoc + ".color_token");
          totalReferencesCount++;
        } else {
          color = asString(stopRec.color, ctx, sLoc + ".color");
          if (!COLOR_HEX_REGEX.test(color)) {
            fail(
              ctx,
              "BRAND_INVALID_COLOR_VALUE",
              "Gradient stop literal color '" + color + "' must be 8 uppercase hex digits '#RRGGBBAA'.",
              sLoc + ".color",
            );
          }
        }

        stops.push(
          Object.freeze({
            offset,
            ...(colorToken === undefined ? {} : { colorToken }),
            ...(color === undefined ? {} : { color }),
          }),
        );
      }

      gradients.push(
        Object.freeze({
          id,
          type: "gradient",
          kind: "linear",
          units,
          x1,
          y1,
          x2,
          y2,
          stops: Object.freeze(stops),
        }),
      );
    }

    // 3. Dimensions
    const dimensionsRaw = root.dimensions === undefined ? [] : asArray(root.dimensions, ctx, "dimensions");
    const dimensions: BrandDimensionToken[] = [];
    for (let i = 0; i < dimensionsRaw.length; i++) {
      const loc = "dimensions[" + i + "]";
      const rec = asRecord(dimensionsRaw[i], ctx, loc);
      expectKeys(rec, ["id", "unit", "value"], ctx, loc);

      const id = validateIdentifier(rec.id, ctx, loc + ".id");
      if (seenTokenIds.has(id)) {
        fail(ctx, "BRAND_DUPLICATE_TOKEN", "Duplicate token id '" + id + "'.", loc + ".id");
      }
      seenTokenIds.add(id);

      const unitStr = asString(rec.unit, ctx, loc + ".unit");
      if (!(BRAND_DIMENSION_UNITS as readonly string[]).includes(unitStr)) {
        fail(
          ctx,
          "SCHEMA_INVALID_ENUM",
          "Dimension unit '" + unitStr + "' is invalid; expected one of " + BRAND_DIMENSION_UNITS.join(", ") + ".",
          loc + ".unit",
        );
      }
      const unit = unitStr as BrandDimensionUnits;

      const val = asInteger(rec.value, ctx, loc + ".value", -1000000000, 1000000000);

      dimensions.push(Object.freeze({ id, type: "dimension", unit, value: val }));
    }

    // 4. Opacities
    const opacitiesRaw = root.opacities === undefined ? [] : asArray(root.opacities, ctx, "opacities");
    const opacities: BrandOpacityToken[] = [];
    for (let i = 0; i < opacitiesRaw.length; i++) {
      const loc = "opacities[" + i + "]";
      const rec = asRecord(opacitiesRaw[i], ctx, loc);
      expectKeys(rec, ["id", "value"], ctx, loc);

      const id = validateIdentifier(rec.id, ctx, loc + ".id");
      if (seenTokenIds.has(id)) {
        fail(ctx, "BRAND_DUPLICATE_TOKEN", "Duplicate token id '" + id + "'.", loc + ".id");
      }
      seenTokenIds.add(id);

      const val = asInteger(rec.value, ctx, loc + ".value", 0, 1000000);

      opacities.push(Object.freeze({ id, type: "opacity", value: val }));
    }

    // Global token count limit <= 256
    const totalTokensCount = colors.length + gradients.length + dimensions.length + opacities.length;
    if (totalTokensCount > BRAND_TOKENS_MAX_COUNT) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Total token count " + totalTokensCount + " exceeds limit " + BRAND_TOKENS_MAX_COUNT + ".",
        "tokens",
      );
    }

    // Reference count limit <= 1024
    if (totalReferencesCount > BRAND_TOKENS_MAX_REFERENCES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Total token references count " + totalReferencesCount + " exceeds limit " + BRAND_TOKENS_MAX_REFERENCES + ".",
        "gradients",
      );
    }

    // Reference validation & graph cycle/depth checks
    for (const gradient of gradients) {
      for (const stop of gradient.stops) {
        if (stop.colorToken !== undefined) {
          if (!seenTokenIds.has(stop.colorToken)) {
            fail(
              ctx,
              "BRAND_TOKEN_MISSING_REFERENCE",
              "Gradient '" + gradient.id + "' references missing token '" + stop.colorToken + "'.",
              "gradients." + gradient.id,
            );
          }
          if (!colorTokenIds.has(stop.colorToken)) {
            fail(
              ctx,
              "BRAND_TOKEN_TYPE_MISMATCH",
              "Gradient '" + gradient.id + "' stop color_token '" + stop.colorToken + "' references non-color token.",
              "gradients." + gradient.id,
            );
          }
        }
      }
    }

    // Execute the general reference-graph cycle/depth algorithm even though
    // v1 currently permits only gradient -> color edges.
    const referenceGraph = new Map<string, readonly string[]>();
    for (const color of colors) referenceGraph.set(color.id, Object.freeze([]));
    for (const dimension of dimensions) referenceGraph.set(dimension.id, Object.freeze([]));
    for (const opacity of opacities) referenceGraph.set(opacity.id, Object.freeze([]));
    for (const gradient of gradients) {
      referenceGraph.set(
        gradient.id,
        Object.freeze(gradient.stops.flatMap((stop) => stop.colorToken === undefined ? [] : [stop.colorToken])),
      );
    }
    const visiting = new Set<string>();
    const visitedDepth = new Map<string, number>();
    const visitReference = (id: string): number => {
      if (visiting.has(id)) {
        fail(ctx, "BRAND_TOKEN_REFERENCE_CYCLE", "Token reference cycle includes '" + id + "'.", "tokens." + id);
      }
      const priorDepth = visitedDepth.get(id);
      if (priorDepth !== undefined) return priorDepth;
      visiting.add(id);
      let depth = 1;
      for (const referencedId of referenceGraph.get(id) ?? []) {
        depth = Math.max(depth, 1 + visitReference(referencedId));
      }
      visiting.delete(id);
      if (depth > BRAND_TOKENS_MAX_DEPTH) {
        fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Token reference depth " + depth + " exceeds limit " + BRAND_TOKENS_MAX_DEPTH + ".", "tokens." + id);
      }
      visitedDepth.set(id, depth);
      return depth;
    };
    for (const id of referenceGraph.keys()) visitReference(id);

    // Sort arrays canonically
    colors.sort((a, b) => compareUtf8(a.id, b.id));
    gradients.sort((a, b) => compareUtf8(a.id, b.id));
    dimensions.sort((a, b) => compareUtf8(a.id, b.id));
    opacities.sort((a, b) => compareUtf8(a.id, b.id));

    const model: BrandTokensModel = Object.freeze({
      schema: BRAND_TOKENS_SCHEMA_ID,
      schemaVersion: BRAND_TOKENS_SCHEMA_VERSION,
      colors: Object.freeze(colors),
      gradients: Object.freeze(gradients),
      dimensions: Object.freeze(dimensions),
      opacities: Object.freeze(opacities),
    });

    return ok(model);
  } catch (error) {
    return fromCaught(error, ctx, "SCHEMA_INVALID_SYNTAX", "Failed to validate brand-tokens.toml.");
  }
}

export function toBrandTokensCanonicalDto(model: BrandTokensModel): BrandTokensCanonicalDto {
  const sortedColors = [...model.colors].sort((a, b) => compareUtf8(a.id, b.id));
  const sortedGradients = [...model.gradients].sort((a, b) => compareUtf8(a.id, b.id));
  const sortedDimensions = [...model.dimensions].sort((a, b) => compareUtf8(a.id, b.id));
  const sortedOpacities = [...model.opacities].sort((a, b) => compareUtf8(a.id, b.id));

  return {
    colors: sortedColors.map((c) => ({
      id: c.id,
      value: c.value,
    })),
    dimensions: sortedDimensions.map((d) => ({
      id: d.id,
      unit: d.unit,
      value: d.value,
    })),
    gradients: sortedGradients.map((g) => ({
      id: g.id,
      kind: "linear",
      stops: g.stops.map((s) => ({
        ...(s.color === undefined ? {} : { color: s.color }),
        ...(s.colorToken === undefined ? {} : { colorToken: s.colorToken }),
        offset: s.offset,
      })),
      units: g.units,
      x1: g.x1,
      x2: g.x2,
      y1: g.y1,
      y2: g.y2,
    })),
    opacities: sortedOpacities.map((o) => ({
      id: o.id,
      value: o.value,
    })),
    schema: BRAND_TOKENS_SCHEMA_ID,
    schemaVersion: BRAND_TOKENS_SCHEMA_VERSION,
  };
}

export function computeBrandTokensDigest(model: BrandTokensModel): Sha256Digest {
  const dto = toBrandTokensCanonicalDto(model);
  const json = encodeCanonicalJson(dto);
  const preimage = BRAND_TOKENS_DIGEST_BASIS + json;
  return computeSha256(Buffer.from(preimage, "utf8"));
}

export function serializeBrandTokensToml(model: BrandTokensModel): string {
  const lines: string[] = [
    `schema = "${model.schema}"`,
    `schema_version = ${model.schemaVersion}`,
    "",
  ];

  const sortedColors = [...model.colors].sort((a, b) => compareUtf8(a.id, b.id));
  for (const color of sortedColors) {
    lines.push("[[colors]]");
    lines.push(`id = "${color.id}"`);
    lines.push(`value = "${color.value}"`);
    lines.push("");
  }

  const sortedGradients = [...model.gradients].sort((a, b) => compareUtf8(a.id, b.id));
  for (const gradient of sortedGradients) {
    lines.push("[[gradients]]");
    lines.push(`id = "${gradient.id}"`);
    lines.push(`kind = "${gradient.kind}"`);
    lines.push(`units = "${gradient.units}"`);
    lines.push(`x1 = ${gradient.x1}`);
    lines.push(`y1 = ${gradient.y1}`);
    lines.push(`x2 = ${gradient.x2}`);
    lines.push(`y2 = ${gradient.y2}`);
    lines.push("");
    for (const stop of gradient.stops) {
      lines.push("[[gradients.stops]]");
      lines.push(`offset = ${stop.offset}`);
      if (stop.colorToken !== undefined) {
        lines.push(`color_token = "${stop.colorToken}"`);
      }
      if (stop.color !== undefined) {
        lines.push(`color = "${stop.color}"`);
      }
      lines.push("");
    }
  }

  const sortedDimensions = [...model.dimensions].sort((a, b) => compareUtf8(a.id, b.id));
  for (const dimension of sortedDimensions) {
    lines.push("[[dimensions]]");
    lines.push(`id = "${dimension.id}"`);
    lines.push(`unit = "${dimension.unit}"`);
    lines.push(`value = ${dimension.value}`);
    lines.push("");
  }

  const sortedOpacities = [...model.opacities].sort((a, b) => compareUtf8(a.id, b.id));
  for (const opacity of sortedOpacities) {
    lines.push("[[opacities]]");
    lines.push(`id = "${opacity.id}"`);
    lines.push(`value = ${opacity.value}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function findUnusedTokens(
  model: BrandTokensModel,
  directlyUsedTokenIds: ReadonlySet<string>,
): readonly string[] {
  const referencedFromGradients = new Set<string>();
  for (const gradient of model.gradients) {
    if (directlyUsedTokenIds.has(gradient.id)) {
      for (const stop of gradient.stops) {
        if (stop.colorToken !== undefined) {
          referencedFromGradients.add(stop.colorToken);
        }
      }
    }
  }

  const allUsed = new Set([...directlyUsedTokenIds, ...referencedFromGradients]);
  const unused: string[] = [];

  for (const c of model.colors) {
    if (!allUsed.has(c.id)) unused.push(c.id);
  }
  for (const g of model.gradients) {
    if (!allUsed.has(g.id)) unused.push(g.id);
  }
  for (const d of model.dimensions) {
    if (!allUsed.has(d.id)) unused.push(d.id);
  }
  for (const o of model.opacities) {
    if (!allUsed.has(o.id)) unused.push(o.id);
  }

  return Object.freeze(unused.sort(compareUtf8));
}

export function canonicalUsedTokenValue(token: BrandToken, model: BrandTokensModel): string {
  if (token.type === "color") return token.value;
  if (token.type === "dimension") {
    return encodeCanonicalJson({ unit: token.unit, value: token.value });
  }
  if (token.type === "opacity") return String(token.value);
  const colors = new Map(model.colors.map((color) => [color.id, color.value] as const));
  return encodeCanonicalJson({
    kind: token.kind,
    stops: token.stops.map((stop) => ({
      ...(stop.color === undefined ? {} : { color: stop.color }),
      ...(stop.colorToken === undefined ? {} : {
        colorToken: stop.colorToken,
        resolvedColor: colors.get(stop.colorToken),
      }),
      offset: stop.offset,
    })),
    units: token.units,
    x1: token.x1,
    x2: token.x2,
    y1: token.y1,
    y2: token.y2,
  });
}
