import { parse as parseToml, TomlError } from "smol-toml";

import { fail, fromCaught, ok, type DiagnosticContext } from "./diagnostics.js";
import { computeSha256, type Sha256Digest } from "./digests.js";
import { portablePathKey, validatePortablePathValue } from "./source-identity.js";
import type { Result } from "./types.js";

export const SOURCE_MAP_FILENAME = ".tfsb-source-map.toml" as const;
export const SOURCE_MAP_SCHEMA_VERSION = 1 as const;
export const SOURCE_MAP_DIGEST_BASIS = "tfsb-source-map-v1" as const;

export type SourceIdentityStrategy = "explicit" | "basename" | "relative-path";

export interface SourceMapOverrideV1 {
  readonly kind: "override";
  readonly sourcePath: string;
  readonly assetId: string;
}

export interface SourceMapExclusionV1 {
  readonly kind: "exclusion";
  readonly sourcePath: string;
  readonly reason: string;
}

export type SourceMapEntryV1 = SourceMapOverrideV1 | SourceMapExclusionV1;

export interface SourceMapCollectionV1 {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly identity: SourceIdentityStrategy;
  readonly prefix: string;
  readonly includePaths: readonly string[];
  readonly includeTrees: readonly string[];
  readonly excludePaths: readonly string[];
  readonly excludeTrees: readonly string[];
  readonly entries: readonly SourceMapEntryV1[];
}

export interface SourceMapV1 {
  readonly schemaVersion: typeof SOURCE_MAP_SCHEMA_VERSION;
  readonly sourceRoot: ".";
  readonly collections: readonly SourceMapCollectionV1[];
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PREFIX = /^(?:|[a-z0-9]+(?:-[a-z0-9]+)*-)$/;

function context(source?: string): DiagnosticContext {
  const safeSource = source !== undefined && !source.startsWith("/") && !source.includes("\\") && !/^[A-Za-z]:/.test(source) ? source : undefined;
  return { operation: "parse", domain: "source-map", ...(safeSource === undefined ? {} : { source: safeSource }) };
}

function record(value: unknown, ctx: DiagnosticContext, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ctx, "SOURCE_MAP_INVALID_TYPE", "Source-map value must be a table.", location);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], ctx: DiagnosticContext, location: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    fail(ctx, "SOURCE_MAP_UNKNOWN_FIELD", `Unknown source-map field '${unknown}'.`, `${location}.${unknown}`);
  }
}

function string(value: unknown, ctx: DiagnosticContext, location: string): string {
  if (typeof value !== "string") fail(ctx, "SOURCE_MAP_INVALID_TYPE", "Expected a string.", location);
  return value;
}

function strings(value: unknown, ctx: DiagnosticContext, location: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(ctx, "SOURCE_MAP_INVALID_TYPE", "Expected an array of strings.", location);
  }
  return value as string[];
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validateSet(
  values: readonly string[],
  ctx: DiagnosticContext,
  location: string,
  options: { readonly directory?: boolean; readonly svg?: boolean } = {},
): readonly string[] {
  const exact = new Set<string>();
  const portable = new Set<string>();
  for (const [index, value] of values.entries()) {
    validatePortablePathValue(value, ctx, `${location}[${index}]`, { allowDot: options.directory === true });
    if (options.svg === true && !value.endsWith(".svg")) {
      fail(ctx, "SOURCE_MAP_INVALID_SVG_PATH", "Selected SVG paths must use the lowercase .svg suffix.", `${location}[${index}]`);
    }
    const key = portablePathKey(value);
    if (exact.has(value) || portable.has(key)) {
      fail(ctx, "SOURCE_MAP_PATH_COLLISION", "Source-map paths must be exact and portably unique.", `${location}[${index}]`);
    }
    exact.add(value);
    portable.add(key);
  }
  return [...values].sort(compareUtf8);
}

function parseEntry(value: unknown, index: number, ctx: DiagnosticContext): SourceMapEntryV1 {
  const location = `collection.entry[${index}]`;
  const entry = record(value, ctx, location);
  const keys = Object.keys(entry).sort();
  const override = keys.join("\0") === ["asset_id", "source_path"].sort().join("\0");
  const exclusion = keys.join("\0") === ["exclude", "reason", "source_path"].sort().join("\0");
  if (!override && !exclusion) {
    fail(ctx, "SOURCE_MAP_INVALID_ENTRY", "An entry must be exactly an override or a reasoned exclusion.", location);
  }
  const sourcePath = string(entry.source_path, ctx, `${location}.source_path`);
  validatePortablePathValue(sourcePath, ctx, `${location}.source_path`);
  if (!sourcePath.endsWith(".svg")) {
    fail(ctx, "SOURCE_MAP_INVALID_SVG_PATH", "Entry source_path must use the lowercase .svg suffix.", `${location}.source_path`);
  }
  if (override) {
    const assetId = string(entry.asset_id, ctx, `${location}.asset_id`);
    validateProducedId(assetId, ctx, `${location}.asset_id`);
    return { kind: "override", sourcePath, assetId };
  }
  if (entry.exclude !== true) {
    fail(ctx, "SOURCE_MAP_INVALID_ENTRY", "Entry exclusions require exclude = true.", `${location}.exclude`);
  }
  const reason = string(entry.reason, ctx, `${location}.reason`);
  if (reason.trim() === "") fail(ctx, "SOURCE_MAP_INVALID_ENTRY", "Entry exclusion reason cannot be blank.", `${location}.reason`);
  return { kind: "exclusion", sourcePath, reason };
}

function parseCollection(value: unknown, index: number, ctx: DiagnosticContext): SourceMapCollectionV1 {
  const location = `collection[${index}]`;
  const collection = record(value, ctx, location);
  exactKeys(collection, ["id", "name", "root", "identity", "prefix", "include_paths", "include_trees", "exclude_paths", "exclude_trees", "entry"], ctx, location);
  const id = string(collection.id, ctx, `${location}.id`);
  if (!ID.test(id)) fail(ctx, "SOURCE_MAP_INVALID_COLLECTION_ID", "Collection id must use canonical kebab grammar.", `${location}.id`);
  const name = string(collection.name, ctx, `${location}.name`);
  if (name.trim() === "") fail(ctx, "SOURCE_MAP_INVALID_NAME", "Collection name cannot be blank.", `${location}.name`);
  const root = string(collection.root, ctx, `${location}.root`);
  validatePortablePathValue(root, ctx, `${location}.root`, { allowDot: true });
  const identity = collection.identity;
  if (identity !== "explicit" && identity !== "basename" && identity !== "relative-path") {
    fail(ctx, "SOURCE_MAP_INVALID_IDENTITY", "Identity must be explicit, basename, or relative-path.", `${location}.identity`);
  }
  const prefix = string(collection.prefix, ctx, `${location}.prefix`);
  if (!PREFIX.test(prefix)) fail(ctx, "SOURCE_MAP_INVALID_PREFIX", "Prefix must be empty or canonical kebab text ending in '-'.", `${location}.prefix`);
  const includePaths = validateSet(strings(collection.include_paths, ctx, `${location}.include_paths`), ctx, `${location}.include_paths`, { svg: true });
  const includeTrees = validateSet(strings(collection.include_trees, ctx, `${location}.include_trees`), ctx, `${location}.include_trees`, { directory: true });
  const excludePaths = validateSet(strings(collection.exclude_paths, ctx, `${location}.exclude_paths`), ctx, `${location}.exclude_paths`, { svg: true });
  const excludeTrees = validateSet(strings(collection.exclude_trees, ctx, `${location}.exclude_trees`), ctx, `${location}.exclude_trees`, { directory: true });
  if (includePaths.length === 0 && includeTrees.length === 0) {
    fail(ctx, "SOURCE_MAP_EMPTY_SELECTION", "A collection requires at least one inclusion selector.", location);
  }
  const rawEntries = collection.entry === undefined ? [] : collection.entry;
  if (!Array.isArray(rawEntries)) fail(ctx, "SOURCE_MAP_INVALID_TYPE", "entry must be an array of tables.", `${location}.entry`);
  const entries = rawEntries.map((entry, entryIndex) => parseEntry(entry, entryIndex, ctx)).sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath));
  validateSet(entries.map((entry) => entry.sourcePath), ctx, `${location}.entry`);
  return { id, name, root, identity, prefix, includePaths, includeTrees, excludePaths, excludeTrees, entries };
}

function parseDocument(value: unknown, ctx: DiagnosticContext): SourceMapV1 {
  const root = record(value, ctx, "source_map");
  exactKeys(root, ["schema_version", "source_root", "collection"], ctx, "source_map");
  if (root.schema_version !== SOURCE_MAP_SCHEMA_VERSION) {
    fail(ctx, "SOURCE_MAP_UNSUPPORTED_VERSION", "Source-map schema_version must be 1.", "schema_version");
  }
  if (root.source_root !== ".") fail(ctx, "SOURCE_MAP_INVALID_ROOT", "source_root must be '.'.", "source_root");
  if (!Array.isArray(root.collection) || root.collection.length === 0) {
    fail(ctx, "SOURCE_MAP_INVALID_COLLECTIONS", "collection must be a non-empty array of tables.", "collection");
  }
  const collections = root.collection.map((collection, index) => parseCollection(collection, index, ctx)).sort((left, right) => compareUtf8(left.id, right.id));
  const ids = new Set<string>();
  for (const collection of collections) {
    if (ids.has(collection.id)) fail(ctx, "SOURCE_MAP_DUPLICATE_COLLECTION", `Collection id '${collection.id}' is duplicated.`, collection.id);
    ids.add(collection.id);
  }
  return { schemaVersion: SOURCE_MAP_SCHEMA_VERSION, sourceRoot: ".", collections };
}

export function validateProducedId(value: string, ctx: DiagnosticContext, location: string): void {
  if (!ID.test(value)) fail(ctx, "SOURCE_IDENTITY_INVALID", "Source-map asset ID must use canonical kebab grammar.", location);
  if (Buffer.byteLength(value, "utf8") > 64) fail(ctx, "SOURCE_IDENTITY_TOO_LONG", "Source-map asset ID exceeds 64 UTF-8 bytes.", location);
}

export function parseSourceMap(text: string, source?: string): Result<SourceMapV1> {
  const ctx = context(source);
  try {
    return ok(parseDocument(parseToml(text.replace(/^\uFEFF/, "")), ctx));
  } catch (error) {
    return fromCaught(error, ctx, "SOURCE_MAP_INVALID_TOML", "Source-map TOML is invalid.", (caught) => caught instanceof TomlError);
  }
}

function basic(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007F").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function array(values: readonly string[]): string {
  return `[${values.map(basic).join(", ")}]`;
}

export function serializeSourceMap(value: SourceMapV1): string {
  const parsed = parseDocument({
    schema_version: value.schemaVersion,
    source_root: value.sourceRoot,
    collection: value.collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      root: collection.root,
      identity: collection.identity,
      prefix: collection.prefix,
      include_paths: [...collection.includePaths],
      include_trees: [...collection.includeTrees],
      exclude_paths: [...collection.excludePaths],
      exclude_trees: [...collection.excludeTrees],
      entry: collection.entries.map((entry) => entry.kind === "override"
        ? { source_path: entry.sourcePath, asset_id: entry.assetId }
        : { source_path: entry.sourcePath, exclude: true, reason: entry.reason }),
    })),
  }, context());
  const lines = ["schema_version = 1", 'source_root = "."'];
  for (const collection of parsed.collections) {
    lines.push("", "[[collection]]", `id = ${basic(collection.id)}`, `name = ${basic(collection.name)}`, `root = ${basic(collection.root)}`, `identity = ${basic(collection.identity)}`, `prefix = ${basic(collection.prefix)}`, `include_paths = ${array(collection.includePaths)}`, `include_trees = ${array(collection.includeTrees)}`, `exclude_paths = ${array(collection.excludePaths)}`, `exclude_trees = ${array(collection.excludeTrees)}`);
    for (const entry of collection.entries) {
      lines.push("", "[[collection.entry]]", `source_path = ${basic(entry.sourcePath)}`);
      if (entry.kind === "override") lines.push(`asset_id = ${basic(entry.assetId)}`);
      else lines.push("exclude = true", `reason = ${basic(entry.reason)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function computeSourceMapDigest(value: SourceMapV1): Sha256Digest {
  return computeSha256(Buffer.from(`${SOURCE_MAP_DIGEST_BASIS}\n${serializeSourceMap(value)}`, "utf8"));
}
