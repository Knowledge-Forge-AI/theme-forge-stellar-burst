import { describe, expect, it } from "vitest";

import {
  BRAND_RECIPES_DIGEST_BASIS,
  BRAND_RECIPES_MAX_BYTES,
  BRAND_RECIPES_MAX_GRAPH_DEPTH,
  BRAND_RECIPES_MAX_OPERATIONS_PER_RECIPE,
  BRAND_RECIPES_MAX_RECIPES,
  BRAND_RECIPES_SCHEMA_ID,
  BRAND_RECIPES_SCHEMA_VERSION,
  buildRecipeGraph,
  computeBrandRecipesDigest,
  parseBrandRecipesToml,
  serializeBrandRecipesToml,
  toBrandRecipesCanonicalDto,
} from "../../src/brand/recipes.js";
import { firstCode, unwrap } from "../helpers.js";

describe("Brand Recipes schema 1", () => {
  const VALID_RECIPES_TOML = `# Brand Recipes Model
schema = "tfsb.brand-recipes"
schema_version = 1

[[recipes]]
id = "recipe-mark-dark"
target_asset = "fixture-mark-dark"
source_asset = "fixture-mark-light"

[[recipes.operations]]
operation = "replace-paint"
channel = "fill"
source_color = "#000000FF"
replacement_token = "primary-blue"
expected_occurrences = 2

[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"

[[recipes]]
id = "recipe-favicon"
target_asset = "fixture-favicon"
source_asset = "fixture-mark-dark"

[[recipes.operations]]
operation = "remove-group"
group_id = "secondary-details"

[[recipes.operations]]
operation = "resize-canvas"
width = 16
height = 16
view_box = "0 0 16 16"

[[recipes.operations]]
operation = "background-plate"
color_token = "neutral-light"
element_id = "bg-plate"
corner_radius = 2

[[recipes.operations]]
operation = "copy-metadata"
fields = ["metadata_text"]

[[recipes.operations]]
operation = "copy-accessibility"
policy = "replace-explicit"
title = "Favicon Icon"
description = "Simplified icon for tab display"
`;

  it("parses valid brand-recipes.toml and builds DAG graph", () => {
    const model = unwrap(parseBrandRecipesToml(VALID_RECIPES_TOML));
    expect(model.schema).toBe(BRAND_RECIPES_SCHEMA_ID);
    expect(model.schemaVersion).toBe(BRAND_RECIPES_SCHEMA_VERSION);
    expect(model.recipes).toHaveLength(2);

    const graph = buildRecipeGraph(model, { operation: "check", domain: "brand" });
    expect(graph.topologicalOrder).toHaveLength(2);
    expect(graph.topologicalOrder[0]!.id).toBe("recipe-mark-dark");
    expect(graph.topologicalOrder[1]!.id).toBe("recipe-favicon");

    const node1 = graph.nodes.get("recipe-mark-dark")!;
    expect(node1.dependencies).toEqual([]);
    expect(node1.dependents).toEqual(["recipe-favicon"]);

    const node2 = graph.nodes.get("recipe-favicon")!;
    expect(node2.dependencies).toEqual(["recipe-mark-dark"]);
    expect(node2.dependents).toEqual([]);
  });

  it("roundtrips through serializeBrandRecipesToml deterministically", () => {
    const model1 = unwrap(parseBrandRecipesToml(VALID_RECIPES_TOML));
    const toml1 = serializeBrandRecipesToml(model1);
    const model2 = unwrap(parseBrandRecipesToml(toml1));
    const toml2 = serializeBrandRecipesToml(model2);
    expect(toml1).toBe(toml2);
    expect(computeBrandRecipesDigest(model1)).toBe(computeBrandRecipesDigest(model2));
  });

  it("produces deterministic canonical DTO and digest", () => {
    const model = unwrap(parseBrandRecipesToml(VALID_RECIPES_TOML));
    const dto = toBrandRecipesCanonicalDto(model);
    expect(dto).toHaveProperty("schema", BRAND_RECIPES_SCHEMA_ID);
    expect(dto).toHaveProperty("schemaVersion", BRAND_RECIPES_SCHEMA_VERSION);
    expect(dto).toHaveProperty("recipes");

    const digest = computeBrandRecipesDigest(model);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects duplicate target_asset (single-writer rule)", () => {
    const duplicateTargetToml = `schema = "tfsb.brand-recipes"
schema_version = 1

[[recipes]]
id = "recipe-1"
target_asset = "target-shared"
source_asset = "source-1"
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"

[[recipes]]
id = "recipe-2"
target_asset = "target-shared"
source_asset = "source-2"
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`;
    expect(firstCode(parseBrandRecipesToml(duplicateTargetToml))).toBe("BRAND_RECIPE_DUPLICATE_TARGET");
  });

  it("rejects duplicate recipe IDs", () => {
    const duplicateIdToml = `schema = "tfsb.brand-recipes"
schema_version = 1

[[recipes]]
id = "shared-id"
target_asset = "target-1"
source_asset = "source-1"
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"

[[recipes]]
id = "shared-id"
target_asset = "target-2"
source_asset = "source-2"
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`;
    expect(firstCode(parseBrandRecipesToml(duplicateIdToml))).toBe("BRAND_DUPLICATE_RECIPE");
  });

  it("detects dependency cycles in recipe DAG", () => {
    const cycleToml = `schema = "tfsb.brand-recipes"
schema_version = 1

[[recipes]]
id = "recipe-a"
target_asset = "asset-b"
source_asset = "asset-c"
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"

[[recipes]]
id = "recipe-b"
target_asset = "asset-c"
source_asset = "asset-b"
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`;
    const model = unwrap(parseBrandRecipesToml(cycleToml));
    expect(() => buildRecipeGraph(model, { operation: "check", domain: "brand" })).toThrowError();
  });

  it("enforces max graph depth 8", () => {
    const chain = (count: number): string => {
      let deepToml = `schema = "tfsb.brand-recipes"\nschema_version = 1\n`;
      for (let i = 0; i < count; i++) deepToml += `
[[recipes]]
id = "recipe-${i}"
target_asset = "asset-${i + 1}"
source_asset = "asset-${i}"
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`;
      return deepToml;
    };
    expect(buildRecipeGraph(unwrap(parseBrandRecipesToml(chain(8))), { operation: "check", domain: "brand" }).topologicalOrder).toHaveLength(8);
    expect(() => buildRecipeGraph(unwrap(parseBrandRecipesToml(chain(9))), { operation: "check", domain: "brand" })).toThrowError();
  });

  it("validates monochrome, retain-groups, and replace-paint gradient operations", () => {
    const otherOpsToml = `schema = "tfsb.brand-recipes"
schema_version = 1

[[recipes]]
id = "recipe-mono"
target_asset = "asset-mono"
source_asset = "asset-src"

[[recipes.operations]]
operation = "monochrome"
color_token = "neutral-dark"
channels = ["fill", "stroke"]
expected_occurrences = 4

[[recipes.operations]]
operation = "retain-groups"
group_ids = ["group-a", "group-b"]
expected_before_count = 5
expected_after_count = 2

[[recipes.operations]]
operation = "replace-paint"
channel = "fill"
source_gradient = "old-grad"
replacement_token = "new-grad-token"
expected_occurrences = 1

[[recipes.operations]]
operation = "copy-accessibility"
policy = "decorative"
`;
    const model = unwrap(parseBrandRecipesToml(otherOpsToml));
    expect(model.recipes[0]!.operations).toHaveLength(4);
    expect(model.recipes[0]!.operations[0]!.operation).toBe("monochrome");
    expect(model.recipes[0]!.operations[1]!.operation).toBe("retain-groups");
    expect(model.recipes[0]!.operations[2]!.operation).toBe("replace-paint");
    expect(model.recipes[0]!.operations[3]!.operation).toBe("copy-accessibility");
  });

  it("rejects unknown keys under closed-schema rules", () => {
    const unknownKey = `schema = "tfsb.brand-recipes"
schema_version = 1
recipes = []
extra = "disallowed"
`;
    expect(firstCode(parseBrandRecipesToml(unknownKey))).toBe("SCHEMA_UNKNOWN_KEY");
  });

  it("closes operation fields, IDs, view boxes, accessibility text, and metadata spelling", () => {
    const oneOperation = (operation: string): string => `schema = "tfsb.brand-recipes"
schema_version = 1
[[recipes]]
id = "recipe-one"
target_asset = "target-one"
source_asset = "source-one"
${operation}`;
    expect(firstCode(parseBrandRecipesToml(oneOperation(`[[recipes.operations]]
operation = "retain-groups"
group_ids = ["group-one"]
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`)))).toBe("SCHEMA_INVALID_TYPE");
    expect(parseBrandRecipesToml(oneOperation(`[[recipes.operations]]
operation = "remove-group"
group_id = "bad id"
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`)).ok).toBe(false);
    for (const viewBox of ["0 0 1e2 16", "0 0 16.0 16", "0 0 NaN 16", "0 0 Infinity 16", "0 0 0 16"]) {
      expect(parseBrandRecipesToml(oneOperation(`[[recipes.operations]]
operation = "resize-canvas"
width = 16
height = 16
view_box = "${viewBox}"
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`)).ok).toBe(false);
    }
    expect(firstCode(parseBrandRecipesToml(oneOperation(`[[recipes.operations]]
operation = "copy-metadata"
fields = ["text"]
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`)))).toBe("BRAND_INVALID_METADATA_FIELD");
    expect(firstCode(parseBrandRecipesToml(oneOperation(`[[recipes.operations]]
operation = "copy-metadata"
fields = ["metadata_text", "metadata_text"]
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`)))).toBe("SCHEMA_DUPLICATE_KEY");
    expect(firstCode(parseBrandRecipesToml(oneOperation(`[[recipes.operations]]
operation = "replace-paint"
channel = "gradient-stop"
source_gradient = "gradient-one"
replacement_token = "gradient-token"
expected_occurrences = 1
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`)))).toBe("BRAND_INVALID_OPERATION");
    expect(firstCode(parseBrandRecipesToml(oneOperation(`[[recipes.operations]]
operation = "background-plate"
color_token = "plate"
element_id = "plate-id"
x = 0
[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`)))).toBe("BRAND_INVALID_OPERATION");
    expect(firstCode(parseBrandRecipesToml(oneOperation(`[[recipes.operations]]
operation = "copy-accessibility"
policy = "replace-explicit"
title = "bad\\u0001text"
`)))).toBe("SCHEMA_INVALID_TEXT");
    expect(firstCode(parseBrandRecipesToml(oneOperation(`[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
command = "curl https://example.invalid"
`)))).toBe("SCHEMA_UNKNOWN_KEY");
  });

  it("accepts the closed 2,048-operation/128-target boundary and rejects boundary plus one", () => {
    const recipe = (index: number, operationCount: number): string => {
      let text = `\n[[recipes]]\nid = "recipe-${index}"\ntarget_asset = "target-${index}"\nsource_asset = "source-${index}"\n`;
      for (let op = 1; op < operationCount; op++) text += `[[recipes.operations]]\noperation = "copy-metadata"\nfields = ["metadata_text"]\n`;
      return text + `[[recipes.operations]]\noperation = "copy-accessibility"\npolicy = "preserve"\n`;
    };
    let boundary = `schema = "tfsb.brand-recipes"\nschema_version = 1\n`;
    for (let index = 0; index < BRAND_RECIPES_MAX_RECIPES; index++) boundary += recipe(index, BRAND_RECIPES_MAX_OPERATIONS_PER_RECIPE);
    const parsed = unwrap(parseBrandRecipesToml(boundary));
    expect(parsed.recipes).toHaveLength(128);
    expect(parsed.recipes.reduce((sum, item) => sum + item.operations.length, 0)).toBe(2048);
    expect(firstCode(parseBrandRecipesToml(boundary + recipe(128, 1)))).toBe("RESOURCE_LIMIT_EXCEEDED");
  });
});
