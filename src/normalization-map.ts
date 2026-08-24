import { parse as parseToml, TomlError } from "smol-toml";

import { DiagnosticError, fail, fromCaught, ok, type DiagnosticContext } from "./diagnostics.js";
import type { Result } from "./types.js";

export const NORMALIZATION_MAP_SCHEMA_VERSION = 1 as const;

export type UnlabelledAccessibilityAuthority = "decorative" | "consumer_labelled";

export interface NormalizationMapEntryV1 {
  readonly source: string;
  readonly accessibility: UnlabelledAccessibilityAuthority;
}

export interface NormalizationMapV1 {
  readonly schemaVersion: typeof NORMALIZATION_MAP_SCHEMA_VERSION;
  readonly defaultUnlabelledMode?: UnlabelledAccessibilityAuthority;
  readonly entries: readonly NormalizationMapEntryV1[];
}

function context(source?: string): DiagnosticContext {
  return { operation: "import", domain: "project", ...(source === undefined ? {} : { source }) };
}

function object(value: unknown, ctx: DiagnosticContext, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ctx, "NORMALIZATION_MAP_INVALID_TYPE", "Normalization map value must be a table.", location);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], ctx: DiagnosticContext, location: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) fail(ctx, "NORMALIZATION_MAP_UNKNOWN_FIELD", `Unknown normalization-map field '${unknown}'.`, `${location}.${unknown}`);
}

function authority(value: unknown, ctx: DiagnosticContext, location: string): UnlabelledAccessibilityAuthority {
  if (value !== "decorative" && value !== "consumer_labelled") {
    fail(ctx, "NORMALIZATION_MAP_INVALID_AUTHORITY", "Accessibility authority must be decorative or consumer_labelled.", location);
  }
  return value;
}

function normalizedSource(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") fail(ctx, "NORMALIZATION_MAP_INVALID_SOURCE", "Map source must be a string.", location);
  const segments = value.split("/");
  if (
    value === "" || value !== value.normalize("NFC") || value.includes("\\") || value.includes("\0") ||
    value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.endsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) fail(ctx, "NORMALIZATION_MAP_INVALID_SOURCE", "Map source must be a normalized portable archive entry name.", location);
  return value;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function parseDocument(value: unknown, ctx: DiagnosticContext): NormalizationMapV1 {
  const root = object(value, ctx, "normalization_map");
  exactKeys(root, ["schema_version", "defaults", "entry"], ctx, "normalization_map");
  if (root.schema_version !== NORMALIZATION_MAP_SCHEMA_VERSION) {
    fail(ctx, "NORMALIZATION_MAP_UNSUPPORTED_VERSION", "Normalization-map schema_version must be 1.", "schema_version");
  }
  let defaultUnlabelledMode: UnlabelledAccessibilityAuthority | undefined;
  if (root.defaults !== undefined) {
    const defaults = object(root.defaults, ctx, "defaults");
    exactKeys(defaults, ["unlabelled_mode"], ctx, "defaults");
    if (defaults.unlabelled_mode === undefined) fail(ctx, "NORMALIZATION_MAP_MISSING_AUTHORITY", "defaults.unlabelled_mode is required.", "defaults.unlabelled_mode");
    defaultUnlabelledMode = authority(defaults.unlabelled_mode, ctx, "defaults.unlabelled_mode");
  }
  const rawEntries = root.entry === undefined ? [] : root.entry;
  if (!Array.isArray(rawEntries)) fail(ctx, "NORMALIZATION_MAP_INVALID_TYPE", "entry must be an array of tables.", "entry");
  const entries = rawEntries.map((item, index) => {
    const entry = object(item, ctx, `entry[${index}]`);
    exactKeys(entry, ["source", "accessibility"], ctx, `entry[${index}]`);
    return {
      source: normalizedSource(entry.source, ctx, `entry[${index}].source`),
      accessibility: authority(entry.accessibility, ctx, `entry[${index}].accessibility`),
    };
  }).sort((left, right) => compareUtf8(left.source, right.source));
  const portable = new Set<string>();
  for (const entry of entries) {
    const key = entry.source.toLowerCase();
    if (portable.has(key)) fail(ctx, "NORMALIZATION_MAP_DUPLICATE_AUTHORITY", "Duplicate or portable-colliding source authority.", entry.source);
    portable.add(key);
  }
  return {
    schemaVersion: NORMALIZATION_MAP_SCHEMA_VERSION,
    ...(defaultUnlabelledMode === undefined ? {} : { defaultUnlabelledMode }),
    entries,
  };
}

export function parseNormalizationMap(text: string, source?: string): Result<NormalizationMapV1> {
  const ctx = context(source);
  try { return ok(parseDocument(parseToml(text.replace(/^\uFEFF/, "")), ctx)); }
  catch (error) { return fromCaught(error, ctx, "NORMALIZATION_MAP_INVALID_TOML", "Normalization map TOML is invalid.", (caught) => caught instanceof TomlError); }
}

function basicString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007F").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function serializeNormalizationMap(value: NormalizationMapV1): string {
  const parsed = parseDocument({
    schema_version: value.schemaVersion,
    ...(value.defaultUnlabelledMode === undefined ? {} : { defaults: { unlabelled_mode: value.defaultUnlabelledMode } }),
    entry: value.entries.map((entry) => ({ source: entry.source, accessibility: entry.accessibility })),
  }, context());
  const lines = ["schema_version = 1"];
  if (parsed.defaultUnlabelledMode !== undefined) lines.push("", "[defaults]", `unlabelled_mode = ${basicString(parsed.defaultUnlabelledMode)}`);
  for (const entry of parsed.entries) lines.push("", "[[entry]]", `source = ${basicString(entry.source)}`, `accessibility = ${basicString(entry.accessibility)}`);
  return `${lines.join("\n")}\n`;
}

export function unwrapNormalizationMap(result: Result<NormalizationMapV1>): NormalizationMapV1 {
  if (result.ok) return result.value;
  const first = result.diagnostics[0];
  if (first === undefined) throw new Error("Normalization-map diagnostics were unexpectedly empty.");
  throw new DiagnosticError(first);
}

export function normalizationAuthorityFor(map: NormalizationMapV1 | undefined, source: string): UnlabelledAccessibilityAuthority | undefined {
  return map?.entries.find((entry) => entry.source === source)?.accessibility ?? map?.defaultUnlabelledMode;
}
