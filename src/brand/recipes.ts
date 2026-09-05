import { parse as parseToml, TomlError } from "smol-toml";

import { fail, fromCaught, ok, type DiagnosticContext } from "../diagnostics.js";
import { computeSha256, type Sha256Digest } from "../digests.js";
import { parseLocalId } from "../primitives.js";
import { compareUtf8 } from "../provenance.js";
import type { ArtworkElementV2, GroupSpecV2, NormalizedAssetV2, PaintV2, RectSpecV2, SvgDocumentV2 } from "../schema2-types.js";
import type { AssetId, HexColor, LocalId, Result, SvgFilename } from "../types.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import type { DerivedReceiptUsedToken } from "./derived-receipt.js";
import type { BrandTokensModel } from "./tokens.js";

export const BRAND_RECIPES_SCHEMA_ID = "tfsb.brand-recipes" as const;
export const BRAND_RECIPES_SCHEMA_VERSION = 1 as const;
export const BRAND_RECIPES_DIGEST_BASIS = "tfsb.brand-recipes-v1\n" as const;
export const BRAND_RECIPE_DIGEST_BASIS = "tfsb.brand-recipe-v1\n" as const;
export const BRAND_RECIPE_OPERATIONS_DIGEST_BASIS = "tfsb.brand-recipe-operations-v1\n" as const;
export const BRAND_RECIPES_MAX_BYTES = 1048576; // 1 MiB
export const BRAND_RECIPES_MAX_RECIPES = 128;
export const BRAND_RECIPES_MIN_OPERATIONS_PER_RECIPE = 1;
export const BRAND_RECIPES_MAX_OPERATIONS_PER_RECIPE = 16;
export const BRAND_RECIPES_MAX_GRAPH_DEPTH = 8;
export const BRAND_RECIPES_MAX_DERIVED_TARGETS = 128;
export const BRAND_RECIPES_MAX_TOTAL_APPLICATIONS = 2048;

export interface ReplacePaintOperation {
  readonly operation: "replace-paint";
  readonly channel: "fill" | "stroke" | "gradient-stop";
  readonly source_color?: string;
  readonly source_gradient?: string;
  readonly replacement_token: string;
  readonly expected_occurrences: number;
}

export interface MonochromeOperation {
  readonly operation: "monochrome";
  readonly channels: readonly ("fill" | "stroke")[];
  readonly color_token: string;
  readonly expected_occurrences: number;
}

export interface RemoveGroupOperation {
  readonly operation: "remove-group";
  readonly group_id: string;
}

export interface RetainGroupsOperation {
  readonly operation: "retain-groups";
  readonly group_ids: readonly string[];
  readonly expected_before_count: number;
  readonly expected_after_count: number;
}

export interface BackgroundPlateOperation {
  readonly operation: "background-plate";
  readonly color_token: string;
  readonly element_id: string;
  readonly corner_radius?: number;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface ResizeCanvasOperation {
  readonly operation: "resize-canvas";
  readonly width: number;
  readonly height: number;
  readonly view_box: readonly [number, number, number, number];
}

export interface CopyAccessibilityOperation {
  readonly operation: "copy-accessibility";
  readonly policy: "preserve" | "replace-explicit" | "decorative";
  readonly title?: string;
  readonly description?: string;
}

export interface CopyMetadataOperation {
  readonly operation: "copy-metadata";
  readonly fields: readonly string[];
}

export type BrandRecipeOperation =
  | ReplacePaintOperation
  | MonochromeOperation
  | RemoveGroupOperation
  | RetainGroupsOperation
  | BackgroundPlateOperation
  | ResizeCanvasOperation
  | CopyAccessibilityOperation
  | CopyMetadataOperation;

export interface BrandRecipe {
  readonly id: string;
  readonly source_asset: string;
  readonly target_asset: string;
  readonly rationale?: string;
  readonly operations: readonly BrandRecipeOperation[];
}

export interface BrandRecipesModel {
  readonly schema: typeof BRAND_RECIPES_SCHEMA_ID;
  readonly schemaVersion: typeof BRAND_RECIPES_SCHEMA_VERSION;
  readonly recipes: readonly BrandRecipe[];
}

export interface RecipeGraphNode {
  readonly recipe: BrandRecipe;
  readonly dependencies: readonly string[]; // recipe IDs that must execute before this recipe
  readonly dependents: readonly string[]; // recipe IDs that depend on this recipe
}

export interface RecipeGraph {
  readonly nodes: ReadonlyMap<string, RecipeGraphNode>;
  readonly recipesByTarget: ReadonlyMap<string, BrandRecipe>;
  readonly topologicalOrder: readonly BrandRecipe[];
}

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const COLOR_HEX_REGEX = /^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/;

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

function parseOperation(value: unknown, ctx: DiagnosticContext, location: string): BrandRecipeOperation {
  const rec = asRecord(value, ctx, location);
  const opType = asString(rec.operation, ctx, location + ".operation");

  if (opType === "replace-paint") {
    expectKeys(
      rec,
      ["operation", "channel", "source_color", "source_gradient", "replacement_token", "expected_occurrences"],
      ctx,
      location,
    );
    const channelStr = asString(rec.channel, ctx, location + ".channel");
    if (channelStr !== "fill" && channelStr !== "stroke" && channelStr !== "gradient-stop") {
      fail(
        ctx,
        "SCHEMA_INVALID_ENUM",
        "replace-paint channel must be 'fill', 'stroke', or 'gradient-stop', got '" + channelStr + "'.",
        location + ".channel",
      );
    }
    const channel = channelStr as "fill" | "stroke" | "gradient-stop";

    const hasSourceColor = rec.source_color !== undefined;
    const hasSourceGradient = rec.source_gradient !== undefined;
    if (hasSourceColor && hasSourceGradient) {
      fail(ctx, "BRAND_INVALID_OPERATION", "replace-paint cannot specify both source_color and source_gradient.", location);
    }
    if (!hasSourceColor && !hasSourceGradient) {
      fail(ctx, "BRAND_INVALID_OPERATION", "replace-paint must specify either source_color or source_gradient.", location);
    }
    if (channel === "gradient-stop" && !hasSourceColor) {
      fail(ctx, "BRAND_INVALID_OPERATION", "gradient-stop replace-paint requires source_color and forbids source_gradient.", location);
    }
    if (hasSourceGradient && channel === "gradient-stop") {
      fail(ctx, "BRAND_INVALID_OPERATION", "A gradient replacement is valid only for fill or stroke.", location);
    }

    let source_color: string | undefined;
    let source_gradient: string | undefined;
    if (hasSourceColor) {
      const col = asString(rec.source_color, ctx, location + ".source_color");
      if (!COLOR_HEX_REGEX.test(col)) {
        fail(ctx, "BRAND_INVALID_COLOR_VALUE", "source_color '" + col + "' must be uppercase hex #RRGGBB or #RRGGBBAA.", location + ".source_color");
      }
      source_color = col;
    } else {
      source_gradient = parseLocalId(rec.source_gradient, ctx, location + ".source_gradient");
    }

    const replacement_token = validateIdentifier(rec.replacement_token, ctx, location + ".replacement_token");
    const expected_occurrences = asInteger(rec.expected_occurrences, ctx, location + ".expected_occurrences", 1, 2048);

    return Object.freeze({
      operation: "replace-paint",
      channel,
      ...(source_color === undefined ? {} : { source_color }),
      ...(source_gradient === undefined ? {} : { source_gradient }),
      replacement_token,
      expected_occurrences,
    });
  }

  if (opType === "monochrome") {
    expectKeys(rec, ["operation", "channels", "color_token", "expected_occurrences"], ctx, location);
    const channelsRaw = asArray(rec.channels, ctx, location + ".channels");
    if (channelsRaw.length === 0 || channelsRaw.length > 2) {
      fail(ctx, "SCHEMA_INVALID_RANGE", "monochrome channels must contain 1 or 2 entries.", location + ".channels");
    }
    const seenChannels = new Set<string>();
    const channels: ("fill" | "stroke")[] = [];
    for (let c = 0; c < channelsRaw.length; c++) {
      const ch = asString(channelsRaw[c], ctx, location + ".channels[" + c + "]");
      if (ch !== "fill" && ch !== "stroke") {
        fail(ctx, "SCHEMA_INVALID_ENUM", "monochrome channel must be 'fill' or 'stroke', got '" + ch + "'.", location + ".channels[" + c + "]");
      }
      if (seenChannels.has(ch)) {
        fail(ctx, "SCHEMA_DUPLICATE_KEY", "Duplicate channel in monochrome channels.", location + ".channels[" + c + "]");
      }
      seenChannels.add(ch);
      channels.push(ch as "fill" | "stroke");
    }
    channels.sort(compareUtf8);

    const color_token = validateIdentifier(rec.color_token, ctx, location + ".color_token");
    const expected_occurrences = asInteger(rec.expected_occurrences, ctx, location + ".expected_occurrences", 1, 2048);

    return Object.freeze({
      operation: "monochrome",
      channels: Object.freeze(channels),
      color_token,
      expected_occurrences,
    });
  }

  if (opType === "remove-group") {
    expectKeys(rec, ["operation", "group_id"], ctx, location);
    const group_id = parseLocalId(rec.group_id, ctx, location + ".group_id");
    return Object.freeze({ operation: "remove-group", group_id });
  }

  if (opType === "retain-groups") {
    expectKeys(rec, ["operation", "group_ids", "expected_before_count", "expected_after_count"], ctx, location);
    const groupIdsRaw = asArray(rec.group_ids, ctx, location + ".group_ids");
    if (groupIdsRaw.length === 0) {
      fail(ctx, "SCHEMA_INVALID_RANGE", "retain-groups group_ids cannot be empty.", location + ".group_ids");
    }
    const seenGroupIds = new Set<string>();
    const group_ids: string[] = [];
    for (let g = 0; g < groupIdsRaw.length; g++) {
      const gid = parseLocalId(groupIdsRaw[g], ctx, location + ".group_ids[" + g + "]");
      if (seenGroupIds.has(gid)) {
        fail(ctx, "SCHEMA_DUPLICATE_KEY", "Duplicate group_id in retain-groups.", location + ".group_ids[" + g + "]");
      }
      seenGroupIds.add(gid);
      group_ids.push(gid);
    }
    group_ids.sort(compareUtf8);

    const expected_before_count = asInteger(rec.expected_before_count, ctx, location + ".expected_before_count", 0, 10000);
    const expected_after_count = asInteger(rec.expected_after_count, ctx, location + ".expected_after_count", 0, 10000);

    return Object.freeze({
      operation: "retain-groups",
      group_ids: Object.freeze(group_ids),
      expected_before_count,
      expected_after_count,
    });
  }

  if (opType === "background-plate") {
    expectKeys(rec, ["operation", "color_token", "element_id", "corner_radius", "x", "y", "width", "height"], ctx, location);
    const color_token = validateIdentifier(rec.color_token, ctx, location + ".color_token");
    const element_id = parseLocalId(rec.element_id, ctx, location + ".element_id");
    const corner_radius = rec.corner_radius === undefined ? undefined : asInteger(rec.corner_radius, ctx, location + ".corner_radius", 0, 100000);
    const x = rec.x === undefined ? undefined : asInteger(rec.x, ctx, location + ".x", -1000000, 1000000);
    const y = rec.y === undefined ? undefined : asInteger(rec.y, ctx, location + ".y", -1000000, 1000000);
    const width = rec.width === undefined ? undefined : asInteger(rec.width, ctx, location + ".width", 1, 1000000);
    const height = rec.height === undefined ? undefined : asInteger(rec.height, ctx, location + ".height", 1, 1000000);
    const explicitBounds = [x, y, width, height].filter((part) => part !== undefined).length;
    if (explicitBounds !== 0 && explicitBounds !== 4) {
      fail(ctx, "BRAND_INVALID_OPERATION", "background-plate requires either no explicit bounds or all of x, y, width, and height.", location);
    }

    return Object.freeze({
      operation: "background-plate",
      color_token,
      element_id,
      ...(corner_radius === undefined ? {} : { corner_radius }),
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    });
  }

  if (opType === "resize-canvas") {
    expectKeys(rec, ["operation", "width", "height", "view_box"], ctx, location);
    const width = asInteger(rec.width, ctx, location + ".width", 1, 16384);
    const height = asInteger(rec.height, ctx, location + ".height", 1, 16384);
    const viewBoxText = asString(rec.view_box, ctx, location + ".view_box");
    const vbParts = viewBoxText.trim().split(/\s+/);
    if (vbParts.length !== 4) {
      fail(ctx, "SCHEMA_INVALID_VIEW_BOX", "view_box must contain four canonical safe integers.", location + ".view_box");
    }
    const view_box = vbParts.map((part, index) => {
      if (!/^-?(?:0|[1-9][0-9]*)$/.test(part)) {
        fail(ctx, "SCHEMA_INVALID_VIEW_BOX", "view_box entries must be unambiguous decimal safe integers.", location + ".view_box[" + index + "]");
      }
      return asInteger(Number(part), ctx, location + ".view_box[" + index + "]");
    }) as [number, number, number, number];
    if (view_box[2] <= 0 || view_box[3] <= 0) {
      fail(ctx, "SCHEMA_INVALID_RANGE", "view_box width and height must be positive.", location + ".view_box");
    }

    return Object.freeze({
      operation: "resize-canvas",
      width,
      height,
      view_box,
    });
  }

  if (opType === "copy-accessibility") {
    expectKeys(rec, ["operation", "policy", "title", "description"], ctx, location);
    const policyStr = asString(rec.policy, ctx, location + ".policy");
    if (policyStr !== "preserve" && policyStr !== "replace-explicit" && policyStr !== "decorative") {
      fail(ctx, "SCHEMA_INVALID_ENUM", "copy-accessibility policy must be 'preserve', 'replace-explicit', or 'decorative', got '" + policyStr + "'.", location + ".policy");
    }
    const policy = policyStr as "preserve" | "replace-explicit" | "decorative";

    let title: string | undefined;
    let description: string | undefined;

    if (policy === "replace-explicit") {
      title = asString(rec.title, ctx, location + ".title");
      if (title.trim() === "") {
        fail(ctx, "SCHEMA_INVALID_TEXT", "replace-explicit accessibility title cannot be blank.", location + ".title");
      }
      if (rec.description !== undefined) {
        description = asString(rec.description, ctx, location + ".description");
      }
    } else {
      if (rec.title !== undefined || rec.description !== undefined) {
        fail(ctx, "BRAND_INVALID_OPERATION", "title and description are only allowed when policy is 'replace-explicit'.", location);
      }
    }
    const validateAccessibilityText = (value: string | undefined, limit: number, field: string): void => {
      if (value === undefined) return;
      if (Buffer.byteLength(value, "utf8") > limit) {
        fail(ctx, "SCHEMA_INVALID_TEXT", field + " exceeds " + limit + " UTF-8 bytes.", location + "." + field);
      }
      if (/[^\u0009\u000A\u0020-\u007E\u0080-\u{10FFFF}]/u.test(value) || value.includes("\u007f")) {
        fail(ctx, "SCHEMA_INVALID_TEXT", field + " contains a forbidden control character.", location + "." + field);
      }
    };
    validateAccessibilityText(title, 1024, "title");
    validateAccessibilityText(description, 4096, "description");

    return Object.freeze({
      operation: "copy-accessibility",
      policy,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
    });
  }

  if (opType === "copy-metadata") {
    expectKeys(rec, ["operation", "fields"], ctx, location);
    const fieldsRaw = asArray(rec.fields, ctx, location + ".fields");
    if (fieldsRaw.length === 0) {
      fail(ctx, "SCHEMA_INVALID_RANGE", "copy-metadata fields cannot be empty.", location + ".fields");
    }
    const fields: string[] = [];
    const seenFields = new Set<string>();
    for (let f = 0; f < fieldsRaw.length; f++) {
      const fieldStr = asString(fieldsRaw[f], ctx, location + ".fields[" + f + "]");
      if (fieldStr !== "metadata_text") {
        fail(ctx, "BRAND_INVALID_METADATA_FIELD", "Unsupported copy-metadata field '" + fieldStr + "'; only 'metadata_text' is supported.", location + ".fields[" + f + "]");
      }
      if (seenFields.has(fieldStr)) {
        fail(ctx, "SCHEMA_DUPLICATE_KEY", "Duplicate copy-metadata field '" + fieldStr + "'.", location + ".fields[" + f + "]");
      }
      seenFields.add(fieldStr);
      fields.push(fieldStr);
    }
    fields.sort(compareUtf8);

    return Object.freeze({
      operation: "copy-metadata",
      fields: Object.freeze(fields),
    });
  }

  fail(ctx, "SCHEMA_INVALID_ENUM", "Unknown recipe operation '" + opType + "'.", location + ".operation");
}

export function parseBrandRecipesToml(
  source: string,
  sourceName = ".tfsb/brand-recipes.toml",
): Result<BrandRecipesModel> {
  const ctx = context(sourceName);
  try {
    const byteLength = Buffer.byteLength(source, "utf8");
    if (byteLength > BRAND_RECIPES_MAX_BYTES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "brand-recipes.toml size " + byteLength + " bytes exceeds limit " + BRAND_RECIPES_MAX_BYTES + " bytes.",
        sourceName,
      );
    }

    if (source.startsWith("\uFEFF")) {
      fail(ctx, "SCHEMA_INVALID_BOM", "UTF-8 BOM is forbidden in brand-recipes.toml.");
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
      fail(ctx, "SCHEMA_INVALID_SYNTAX", "Failed to parse brand-recipes.toml.");
    }

    const root = asRecord(parsed, ctx, "");
    expectKeys(root, ["schema", "schema_version", "recipes"], ctx, "");

    const schema = asString(root.schema, ctx, "schema");
    if (schema !== BRAND_RECIPES_SCHEMA_ID) {
      fail(ctx, "SCHEMA_INVALID_ID", "Expected schema '" + BRAND_RECIPES_SCHEMA_ID + "', got '" + schema + "'.", "schema");
    }

    const schemaVersion = asInteger(root.schema_version, ctx, "schema_version");
    if (schemaVersion !== BRAND_RECIPES_SCHEMA_VERSION) {
      fail(
        ctx,
        "SCHEMA_INVALID_VERSION",
        "Expected schema_version " + BRAND_RECIPES_SCHEMA_VERSION + ", got " + schemaVersion + ".",
        "schema_version",
      );
    }

    const recipesRaw = asArray(root.recipes, ctx, "recipes");
    if (recipesRaw.length > BRAND_RECIPES_MAX_RECIPES) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Recipes count " + recipesRaw.length + " exceeds limit " + BRAND_RECIPES_MAX_RECIPES + ".",
        "recipes",
      );
    }

    const seenRecipeIds = new Set<string>();
    const seenTargets = new Set<string>();
    const recipes: BrandRecipe[] = [];
    let totalOperationApplications = 0;

    for (let i = 0; i < recipesRaw.length; i++) {
      const loc = "recipes[" + i + "]";
      const rec = asRecord(recipesRaw[i], ctx, loc);
      expectKeys(rec, ["id", "source_asset", "target_asset", "rationale", "operations"], ctx, loc);

      const id = validateIdentifier(rec.id, ctx, loc + ".id");
      if (seenRecipeIds.has(id)) {
        fail(ctx, "BRAND_DUPLICATE_RECIPE", "Duplicate recipe id '" + id + "'.", loc + ".id");
      }
      seenRecipeIds.add(id);

      const source_asset = validateIdentifier(rec.source_asset, ctx, loc + ".source_asset");
      const target_asset = validateIdentifier(rec.target_asset, ctx, loc + ".target_asset");

      if (source_asset === target_asset) {
        fail(
          ctx,
          "BRAND_RECIPE_SELF_REFERENCE",
          "Recipe '" + id + "' source_asset cannot equal target_asset '" + source_asset + "'.",
          loc,
        );
      }

      if (seenTargets.has(target_asset)) {
        fail(
          ctx,
          "BRAND_RECIPE_DUPLICATE_TARGET",
          "Duplicate target_asset '" + target_asset + "'; only one recipe may claim a target.",
          loc + ".target_asset",
        );
      }
      seenTargets.add(target_asset);

      const rationale = rec.rationale === undefined ? undefined : asString(rec.rationale, ctx, loc + ".rationale");
      if (rationale !== undefined && Buffer.byteLength(rationale, "utf8") > 1024) {
        fail(ctx, "SCHEMA_INVALID_TEXT", "Recipe rationale exceeds 1024 bytes.", loc + ".rationale");
      }

      const operationsRaw = asArray(rec.operations, ctx, loc + ".operations");
      if (operationsRaw.length < BRAND_RECIPES_MIN_OPERATIONS_PER_RECIPE || operationsRaw.length > BRAND_RECIPES_MAX_OPERATIONS_PER_RECIPE) {
        fail(
          ctx,
          "RESOURCE_LIMIT_EXCEEDED",
          "Recipe '" + id + "' operations count " + operationsRaw.length + " must be between " + BRAND_RECIPES_MIN_OPERATIONS_PER_RECIPE + " and " + BRAND_RECIPES_MAX_OPERATIONS_PER_RECIPE + ".",
          loc + ".operations",
        );
      }

      const operations: BrandRecipeOperation[] = [];
      let accessibilityCount = 0;

      for (let opIdx = 0; opIdx < operationsRaw.length; opIdx++) {
        const op = parseOperation(operationsRaw[opIdx], ctx, loc + ".operations[" + opIdx + "]");
        if (op.operation === "copy-accessibility") {
          accessibilityCount++;
        }
        operations.push(op);
      }
      totalOperationApplications += operations.length;
      if (totalOperationApplications > BRAND_RECIPES_MAX_TOTAL_APPLICATIONS) {
        fail(ctx, "RESOURCE_LIMIT_EXCEEDED", "Total ordered operation applications " + totalOperationApplications + " exceeds limit " + BRAND_RECIPES_MAX_TOTAL_APPLICATIONS + ".", loc + ".operations");
      }

      if (accessibilityCount !== 1) {
        fail(
          ctx,
          "BRAND_RECIPE_ACCESSIBILITY_REQUIRED",
          "Recipe '" + id + "' must contain exactly one 'copy-accessibility' operation; found " + accessibilityCount + ".",
          loc + ".operations",
        );
      }

      recipes.push(
        Object.freeze({
          id,
          source_asset,
          target_asset,
          ...(rationale === undefined ? {} : { rationale }),
          operations: Object.freeze(operations),
        }),
      );
    }

    recipes.sort((a, b) => compareUtf8(a.id, b.id));

    const model: BrandRecipesModel = Object.freeze({
      schema: BRAND_RECIPES_SCHEMA_ID,
      schemaVersion: BRAND_RECIPES_SCHEMA_VERSION,
      recipes: Object.freeze(recipes),
    });

    return ok(model);
  } catch (error) {
    return fromCaught(error, ctx, "SCHEMA_INVALID_SYNTAX", "Failed to validate brand-recipes.toml.");
  }
}

export function buildRecipeGraph(model: BrandRecipesModel, ctx: DiagnosticContext): RecipeGraph {
  const recipesById = new Map<string, BrandRecipe>();
  const recipesByTarget = new Map<string, BrandRecipe>();

  for (const recipe of model.recipes) {
    recipesById.set(recipe.id, recipe);
    recipesByTarget.set(recipe.target_asset, recipe);
  }

  // Build dependency adjacency
  // recipe A depends on recipe B if A.source_asset == B.target_asset
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const recipe of model.recipes) {
    dependencies.set(recipe.id, new Set());
    dependents.set(recipe.id, new Set());
  }

  for (const recipe of model.recipes) {
    const parentRecipe = recipesByTarget.get(recipe.source_asset);
    if (parentRecipe !== undefined) {
      dependencies.get(recipe.id)!.add(parentRecipe.id);
      dependents.get(parentRecipe.id)!.add(recipe.id);
    }
  }

  // Check DAG acyclicity and compute topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  for (const [id, deps] of dependencies) {
    inDegree.set(id, deps.size);
  }

  // Queue of nodes with inDegree 0
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  queue.sort(compareUtf8);

  const topologicalOrder: BrandRecipe[] = [];
  const depths = new Map<string, number>();
  for (const id of queue) {
    depths.set(id, 1);
  }

  while (queue.length > 0) {
    // Sort queue deterministically
    queue.sort(compareUtf8);
    const currId = queue.shift()!;
    const currRecipe = recipesById.get(currId)!;
    topologicalOrder.push(currRecipe);
    const currDepth = depths.get(currId)!;

    if (currDepth > BRAND_RECIPES_MAX_GRAPH_DEPTH) {
      fail(
        ctx,
        "RESOURCE_LIMIT_EXCEEDED",
        "Recipe DAG depth " + currDepth + " exceeds maximum depth " + BRAND_RECIPES_MAX_GRAPH_DEPTH + ".",
        "recipes." + currId,
      );
    }

    const nextDependents = dependents.get(currId)!;
    for (const depId of nextDependents) {
      const newDeg = (inDegree.get(depId) ?? 0) - 1;
      inDegree.set(depId, newDeg);
      const existingDepth = depths.get(depId) ?? 0;
      depths.set(depId, Math.max(existingDepth, currDepth + 1));
      if (newDeg === 0) {
        queue.push(depId);
      }
    }
  }

  if (topologicalOrder.length !== model.recipes.length) {
    fail(ctx, "BRAND_RECIPE_CYCLE", "Cycle detected in recipe dependency graph.", "recipes");
  }

  const nodes = new Map<string, RecipeGraphNode>();
  for (const recipe of model.recipes) {
    const deps = [...dependencies.get(recipe.id)!].sort(compareUtf8);
    const depsOn = [...dependents.get(recipe.id)!].sort(compareUtf8);
    nodes.set(recipe.id, Object.freeze({
      recipe,
      dependencies: Object.freeze(deps),
      dependents: Object.freeze(depsOn),
    }));
  }

  return Object.freeze({
    nodes,
    recipesByTarget,
    topologicalOrder: Object.freeze(topologicalOrder),
  });
}

export function toBrandRecipesCanonicalDto(model: BrandRecipesModel): Record<string, unknown> {
  const sortedRecipes = [...model.recipes].sort((a, b) => compareUtf8(a.id, b.id));

  return {
    recipes: sortedRecipes.map(toBrandRecipeCanonicalDto),
    schema: BRAND_RECIPES_SCHEMA_ID,
    schemaVersion: BRAND_RECIPES_SCHEMA_VERSION,
  };
}

export function toBrandRecipeOperationsCanonicalDto(recipe: BrandRecipe): readonly Record<string, unknown>[] {
  return recipe.operations.map((op) => {
        if (op.operation === "replace-paint") {
          return {
            channel: op.channel,
            expectedOccurrences: op.expected_occurrences,
            operation: op.operation,
            replacementToken: op.replacement_token,
            ...(op.source_color === undefined ? {} : { sourceColor: op.source_color }),
            ...(op.source_gradient === undefined ? {} : { sourceGradient: op.source_gradient }),
          };
        }
        if (op.operation === "monochrome") {
          return {
            channels: [...op.channels].sort(compareUtf8),
            colorToken: op.color_token,
            expectedOccurrences: op.expected_occurrences,
            operation: op.operation,
          };
        }
        if (op.operation === "remove-group") {
          return {
            groupId: op.group_id,
            operation: op.operation,
          };
        }
        if (op.operation === "retain-groups") {
          return {
            expectedAfterCount: op.expected_after_count,
            expectedBeforeCount: op.expected_before_count,
            groupIds: [...op.group_ids].sort(compareUtf8),
            operation: op.operation,
          };
        }
        if (op.operation === "background-plate") {
          return {
            colorToken: op.color_token,
            ...(op.corner_radius === undefined ? {} : { cornerRadius: op.corner_radius }),
            elementId: op.element_id,
            ...(op.height === undefined ? {} : { height: op.height }),
            operation: op.operation,
            ...(op.width === undefined ? {} : { width: op.width }),
            ...(op.x === undefined ? {} : { x: op.x }),
            ...(op.y === undefined ? {} : { y: op.y }),
          };
        }
        if (op.operation === "resize-canvas") {
          return {
            height: op.height,
            operation: op.operation,
            viewBox: [...op.view_box],
            width: op.width,
          };
        }
        if (op.operation === "copy-accessibility") {
          return {
            ...(op.description === undefined ? {} : { description: op.description }),
            operation: op.operation,
            policy: op.policy,
            ...(op.title === undefined ? {} : { title: op.title }),
          };
        }
        return {
          fields: [...op.fields].sort(compareUtf8),
          operation: op.operation,
        };
  });
}

export function toBrandRecipeCanonicalDto(recipe: BrandRecipe): Record<string, unknown> {
  return {
    id: recipe.id,
    operations: toBrandRecipeOperationsCanonicalDto(recipe),
    ...(recipe.rationale === undefined ? {} : { rationale: recipe.rationale }),
    sourceAsset: recipe.source_asset,
    targetAsset: recipe.target_asset,
  };
}

export function computeBrandRecipeDefinitionDigest(recipe: BrandRecipe): Sha256Digest {
  return computeSha256(Buffer.from(BRAND_RECIPE_DIGEST_BASIS + encodeCanonicalJson(toBrandRecipeCanonicalDto(recipe)), "utf8"));
}

export function computeBrandRecipeOperationsDigest(recipe: BrandRecipe): Sha256Digest {
  return computeSha256(Buffer.from(BRAND_RECIPE_OPERATIONS_DIGEST_BASIS + encodeCanonicalJson(toBrandRecipeOperationsCanonicalDto(recipe)), "utf8"));
}

export function computeBrandRecipesDigest(model: BrandRecipesModel): Sha256Digest {
  const dto = toBrandRecipesCanonicalDto(model);
  const json = encodeCanonicalJson(dto);
  const preimage = BRAND_RECIPES_DIGEST_BASIS + json;
  return computeSha256(Buffer.from(preimage, "utf8"));
}

export function serializeBrandRecipesToml(model: BrandRecipesModel): string {
  const lines: string[] = [
    `schema = "${model.schema}"`,
    `schema_version = ${model.schemaVersion}`,
    "",
  ];

  const sortedRecipes = [...model.recipes].sort((a, b) => compareUtf8(a.id, b.id));
  for (const recipe of sortedRecipes) {
    lines.push("[[recipes]]");
    lines.push(`id = "${recipe.id}"`);
    lines.push(`source_asset = "${recipe.source_asset}"`);
    lines.push(`target_asset = "${recipe.target_asset}"`);
    if (recipe.rationale !== undefined) {
      lines.push(`rationale = ${JSON.stringify(recipe.rationale)}`);
    }
    lines.push("");

    for (const op of recipe.operations) {
      lines.push("[[recipes.operations]]");
      lines.push(`operation = "${op.operation}"`);
      if (op.operation === "replace-paint") {
        lines.push(`channel = "${op.channel}"`);
        if (op.source_color !== undefined) lines.push(`source_color = "${op.source_color}"`);
        if (op.source_gradient !== undefined) lines.push(`source_gradient = "${op.source_gradient}"`);
        lines.push(`replacement_token = "${op.replacement_token}"`);
        lines.push(`expected_occurrences = ${op.expected_occurrences}`);
      } else if (op.operation === "monochrome") {
        const chs = op.channels.map((c) => `"${c}"`).join(", ");
        lines.push(`channels = [${chs}]`);
        lines.push(`color_token = "${op.color_token}"`);
        lines.push(`expected_occurrences = ${op.expected_occurrences}`);
      } else if (op.operation === "remove-group") {
        lines.push(`group_id = "${op.group_id}"`);
      } else if (op.operation === "retain-groups") {
        const gids = op.group_ids.map((g) => `"${g}"`).join(", ");
        lines.push(`group_ids = [${gids}]`);
        lines.push(`expected_before_count = ${op.expected_before_count}`);
        lines.push(`expected_after_count = ${op.expected_after_count}`);
      } else if (op.operation === "background-plate") {
        lines.push(`color_token = "${op.color_token}"`);
        lines.push(`element_id = "${op.element_id}"`);
        if (op.corner_radius !== undefined) lines.push(`corner_radius = ${op.corner_radius}`);
        if (op.x !== undefined) lines.push(`x = ${op.x}`);
        if (op.y !== undefined) lines.push(`y = ${op.y}`);
        if (op.width !== undefined) lines.push(`width = ${op.width}`);
        if (op.height !== undefined) lines.push(`height = ${op.height}`);
      } else if (op.operation === "resize-canvas") {
        lines.push(`width = ${op.width}`);
        lines.push(`height = ${op.height}`);
        lines.push(`view_box = "${op.view_box.join(" ")}"`);
      } else if (op.operation === "copy-accessibility") {
        lines.push(`policy = "${op.policy}"`);
        if (op.title !== undefined) lines.push(`title = ${JSON.stringify(op.title)}`);
        if (op.description !== undefined) lines.push(`description = ${JSON.stringify(op.description)}`);
      } else if (op.operation === "copy-metadata") {
        const flds = op.fields.map((f) => `"${f}"`).join(", ");
        lines.push(`fields = [${flds}]`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
