import { describe, expect, it } from "vitest";

import {
  applyRecipeOperations,
  createBrandDerivedReceipt,
  parseBrandDerivedReceipt,
  serializeBrandDerivedReceipt,
  computeDerivedReceiptDigest,
  computeBrandRecipeDefinitionDigest,
  computeBrandRecipeOperationsDigest,
  DERIVED_RECEIPT_MAX_BYTES,
  toBrandRecipeOperationsCanonicalDto,
  type BrandRecipe,
} from "../../src/index.js";
import { parseBrandTokensToml } from "../../src/brand/tokens.js";
import { parseAssetTomlV2 } from "../../src/schema2-toml.js";
import { serializeAssetTomlV2 } from "../../src/schema2-toml.js";
import { serializeSvgV2 } from "../../src/schema2-svg.js";
import { unwrap } from "../helpers.js";

describe("Brand Derivation Engine & Receipts", () => {
  const RECEIPT_RECIPE: BrandRecipe = {
    id: "derive-dark-variant",
    source_asset: "source-mark",
    target_asset: "target-mark-dark",
    operations: [{ operation: "copy-accessibility", policy: "preserve" }],
  };
  const TOKENS_TOML = `schema = "tfsb.brand-tokens"
schema_version = 1

[[colors]]
id = "brand-blue"
value = "#0066CCFF"

[[colors]]
id = "brand-white"
value = "#FFFFFFFF"

[[colors]]
id = "brand-dark"
value = "#111827FF"
`;

  const SOURCE_ASSET_TOML = `schema_version = 2
id = "source-mark"
filename = "source-mark.svg"

[canvas]
width = 24
height = 24
view_box = "0 0 24 24"

[accessibility]
mode = "labelled"
title = "Source Mark"
title_id = "title-orig"
description = "Source Mark Icon"
description_id = "desc-orig"

[[elements]]
type = "group"
id = "main-group"

[[elements.children]]
type = "path"
d = "M0 0 L10 10"
fill = "#000000"

[[elements]]
type = "group"
id = "extra-group"

[[elements.children]]
type = "path"
d = "M10 10 L20 20"
stroke = "#000000"
`;

  it("applies replace-paint, monochrome, background-plate, resize-canvas, and copy-accessibility", () => {
    const tokens = unwrap(parseBrandTokensToml(TOKENS_TOML));
    const sourceAsset = unwrap(parseAssetTomlV2(SOURCE_ASSET_TOML, ".tfsb/assets/source-mark.toml"));

    const recipe: BrandRecipe = {
      id: "derive-dark-variant",
      target_asset: "target-mark-dark",
      source_asset: "source-mark",
      operations: [
        {
          operation: "replace-paint",
          channel: "fill",
          source_color: "#000000FF",
          replacement_token: "brand-blue",
          expected_occurrences: 1,
        },
        {
          operation: "monochrome",
          color_token: "brand-white",
          channels: ["stroke"],
          expected_occurrences: 1,
        },
        {
          operation: "background-plate",
          color_token: "brand-dark",
          element_id: "bg-plate",
          corner_radius: 4,
        },
        {
          operation: "resize-canvas",
          width: 32,
          height: 32,
          view_box: [0, 0, 32, 32],
        },
        {
          operation: "copy-accessibility",
          policy: "replace-explicit",
          title: "Derived Dark Mark",
          description: "Derived brand asset with background plate",
        },
      ],
    };

    const ctx = { operation: "build" as const, domain: "brand" as const };
    const { targetAsset, usedTokens } = applyRecipeOperations(recipe, sourceAsset, tokens, ctx);

    expect(targetAsset.id).toBe("target-mark-dark");
    expect(targetAsset.filename).toBe("target-mark-dark.svg");
    expect(targetAsset.svg.canvas.width).toBe(32);
    expect(targetAsset.svg.canvas.height).toBe(32);
    expect(targetAsset.svg.canvas.viewBox).toEqual([0, 0, 32, 32]);

    // Background plate is first element
    expect(targetAsset.svg.elements[0]!.type).toBe("rect");
    expect((targetAsset.svg.elements[0] as any).id).toBe("bg-plate");
    expect((targetAsset.svg.elements[0] as any).cornerRadius).toBe(4);
    expect((targetAsset.svg.elements[0] as any).fill).toEqual({ type: "solid", color: "#111827" });

    // Accessibility
    expect(targetAsset.svg.accessibility.mode).toBe("labelled");
    if (targetAsset.svg.accessibility.mode === "labelled") {
      expect(targetAsset.svg.accessibility.title).toBe("Derived Dark Mark");
      expect(targetAsset.svg.accessibility.description).toBe("Derived brand asset with background plate");
      expect(targetAsset.svg.accessibility.titleId).toBe("tfsb-target-mark-dark-title");
      expect(targetAsset.svg.accessibility.descriptionId).toBe("tfsb-target-mark-dark-description");
    }

    // Used tokens
    expect(usedTokens).toHaveLength(3);
    expect(usedTokens.map((t) => t.id)).toEqual(["brand-blue", "brand-dark", "brand-white"]);
  });

  it("applies remove-group and retain-groups correctly", () => {
    const tokens = unwrap(parseBrandTokensToml(TOKENS_TOML));
    const sourceAsset = unwrap(parseAssetTomlV2(SOURCE_ASSET_TOML, ".tfsb/assets/source-mark.toml"));

    const recipe: BrandRecipe = {
      id: "derive-cleaned",
      target_asset: "target-cleaned",
      source_asset: "source-mark",
      operations: [
        {
          operation: "remove-group",
          group_id: "extra-group",
        },
        {
          operation: "retain-groups",
          group_ids: ["main-group"],
          expected_before_count: 1,
          expected_after_count: 1,
        },
        {
          operation: "copy-accessibility",
          policy: "preserve",
        },
      ],
    };

    const ctx = { operation: "build" as const, domain: "brand" as const };
    const { targetAsset } = applyRecipeOperations(recipe, sourceAsset, tokens, ctx);
    expect(targetAsset.svg.elements).toHaveLength(1);
    expect(targetAsset.svg.elements[0]!.type).toBe("group");
    expect((targetAsset.svg.elements[0] as any).id).toBe("main-group");
  });

  it.each([
    ["transparent", "#33669900", 0],
    ["intermediate", "#33669980", 128 / 255],
    ["opaque", "#336699FF", undefined],
  ] as const)("materializes %s RGBA fill alpha through canonical TOML and SVG", (_label, value, expectedOpacity) => {
    const tokens = unwrap(parseBrandTokensToml(TOKENS_TOML + `\n[[colors]]\nid = "alpha-color"\nvalue = "${value}"\n`));
    const sourceAsset = unwrap(parseAssetTomlV2(SOURCE_ASSET_TOML, ".tfsb/assets/source-mark.toml"));
    const recipe: BrandRecipe = {
      id: "derive-alpha",
      target_asset: "target-alpha",
      source_asset: "source-mark",
      operations: [
        { operation: "replace-paint", channel: "fill", source_color: "#000000FF", replacement_token: "alpha-color", expected_occurrences: 1 },
        { operation: "copy-accessibility", policy: "preserve" },
      ],
    };
    const { targetAsset } = applyRecipeOperations(recipe, sourceAsset, tokens, { operation: "build", domain: "brand" });
    const path = (targetAsset.svg.elements[0] as any).children[0];
    expect(path.fill).toEqual({ type: "solid", color: "#336699" });
    expect(path.fillOpacity).toBe(expectedOpacity);
    const toml = serializeAssetTomlV2(targetAsset);
    const svg = unwrap(serializeSvgV2(targetAsset.svg));
    if (expectedOpacity === undefined) {
      expect(toml).not.toContain("fill_opacity");
      expect(svg).not.toContain("fill-opacity");
    } else {
      expect(unwrap(parseAssetTomlV2(toml)).svg.elements).toEqual(targetAsset.svg.elements);
      expect(svg).toContain(`fill-opacity="${expectedOpacity}"`);
    }
  });

  it("applies stroke and background alpha and requires alpha-sensitive source matches", () => {
    const tokens = unwrap(parseBrandTokensToml(TOKENS_TOML + `\n[[colors]]\nid = "half"\nvalue = "#ABCDEF80"\n`));
    const sourceAsset = unwrap(parseAssetTomlV2(SOURCE_ASSET_TOML));
    const recipe: BrandRecipe = {
      id: "derive-alpha-channels",
      target_asset: "target-alpha-channels",
      source_asset: "source-mark",
      operations: [
        { operation: "replace-paint", channel: "stroke", source_color: "#000000FF", replacement_token: "half", expected_occurrences: 1 },
        { operation: "background-plate", color_token: "half", element_id: "alpha-plate" },
        { operation: "copy-accessibility", policy: "preserve" },
      ],
    };
    const { targetAsset } = applyRecipeOperations(recipe, sourceAsset, tokens, { operation: "build", domain: "brand" });
    expect((targetAsset.svg.elements[0] as any).fillOpacity).toBe(128 / 255);
    expect((targetAsset.svg.elements[2] as any).children[0].strokeOpacity).toBe(128 / 255);
    const mismatch: BrandRecipe = {
      ...recipe,
      id: "derive-alpha-mismatch",
      target_asset: "target-alpha-mismatch",
      operations: [
        { operation: "replace-paint", channel: "fill", source_color: "#00000080", replacement_token: "half", expected_occurrences: 1 },
        { operation: "copy-accessibility", policy: "preserve" },
      ],
    };
    expect(() => applyRecipeOperations(mismatch, sourceAsset, tokens, { operation: "build", domain: "brand" })).toThrow();
  });

  it("materializes gradient coordinate units, stable stop order/alpha, and complete used-token authority", () => {
    const tokens = unwrap(parseBrandTokensToml(TOKENS_TOML + `
[[colors]]
id = "stop-half"
value = "#22446680"

[[gradients]]
id = "hero-gradient"
kind = "linear"
units = "object-bounding-box-millionth"
x1 = 0
y1 = 500000
x2 = 1000000
y2 = 1000000
stops = [
  { offset = 500000, color = "#11223300" },
  { offset = 500000, color_token = "stop-half" },
]
`));
    const sourceAsset = unwrap(parseAssetTomlV2(SOURCE_ASSET_TOML));
    (sourceAsset.svg.definitions.linearGradients as any[]).push({
      id: "old-gradient", x1: 0, y1: 0, x2: 1, y2: 1,
      stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#FFFFFF" }],
    });
    (sourceAsset.svg.elements[0] as any).fill = { type: "linear-gradient", reference: "old-gradient" };
    const recipe: BrandRecipe = {
      id: "derive-gradient",
      target_asset: "target-gradient",
      source_asset: "source-mark",
      operations: [
        { operation: "replace-paint", channel: "fill", source_gradient: "old-gradient", replacement_token: "hero-gradient", expected_occurrences: 1 },
        { operation: "copy-accessibility", policy: "preserve" },
      ],
    };
    const result = applyRecipeOperations(recipe, sourceAsset, tokens, { operation: "build", domain: "brand" });
    const gradient = result.targetAsset.svg.definitions.linearGradients.at(-1)!;
    expect([gradient.x1, gradient.y1, gradient.x2, gradient.y2]).toEqual([0, 0.5, 1, 1]);
    expect(gradient.stops.map((stop) => stop.offset)).toEqual([0.5, 0.5]);
    expect(gradient.stops.map((stop) => stop.opacity)).toEqual([0, 128 / 255]);
    const gradientAuthority = result.usedTokens.find((token) => token.id === "hero-gradient")!.canonicalValue;
    expect(gradientAuthority).toContain('"units":"object-bounding-box-millionth"');
    expect(gradientAuthority).toContain('"resolvedColor":"#22446680"');
  });

  it("fails closed on generated gradient ID collision and traverses every definition paint collection", () => {
    const tokens = unwrap(parseBrandTokensToml(TOKENS_TOML + `
[[gradients]]
id = "hero-gradient"
kind = "linear"
units = "user-space"
x1 = 0
y1 = 5
x2 = 10
y2 = 15
stops = [{ offset = 0, color = "#000000FF" }, { offset = 1000000, color = "#FFFFFFFF" }]
`));
    const sourceAsset = unwrap(parseAssetTomlV2(SOURCE_ASSET_TOML));
    (sourceAsset.svg.definitions.linearGradients as any[]).push({ id: "tfsb-derive-gradient-hero-gradient-grad", x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#FFFFFF" }] });
    (sourceAsset.svg.elements[0] as any).fill = { type: "linear-gradient", reference: "tfsb-derive-gradient-hero-gradient-grad" };
    const collision: BrandRecipe = {
      id: "derive-gradient", target_asset: "target-gradient", source_asset: "source-mark",
      operations: [
        { operation: "replace-paint", channel: "fill", source_gradient: "tfsb-derive-gradient-hero-gradient-grad", replacement_token: "hero-gradient", expected_occurrences: 1 },
        { operation: "copy-accessibility", policy: "preserve" },
      ],
    };
    expect(() => applyRecipeOperations(collision, sourceAsset, tokens, { operation: "build", domain: "brand" })).toThrow();

    const traversalAsset = unwrap(parseAssetTomlV2(SOURCE_ASSET_TOML));
    (traversalAsset.svg as any).metadataText = "Authoritative metadata";
    const painted = { fill: { type: "solid", color: "#000000" } };
    (traversalAsset.svg.definitions.groups as any[]).push({ type: "group", id: "def-group", ...painted, children: [{ type: "path", d: "M0 0L1 1", ...painted }] });
    for (const [name, shape] of Object.entries({ paths: { type: "path", d: "M0 0L1 1" }, circles: { type: "circle", cx: 1, cy: 1, r: 1 }, ellipses: { type: "ellipse", cx: 1, cy: 1, rx: 1, ry: 1 }, rects: { type: "rect", x: 0, y: 0, width: 1, height: 1 }, lines: { type: "line", x1: 0, y1: 0, x2: 1, y2: 1 }, polylines: { type: "polyline", points: [[0, 0], [1, 1]] }, polygons: { type: "polygon", points: [[0, 0], [1, 0], [1, 1]] } })) {
      (traversalAsset.svg.definitions as any)[name].push({ id: `def-${name}`, ...shape, ...painted });
    }
    const mono: BrandRecipe = {
      id: "derive-definitions", target_asset: "target-definitions", source_asset: "source-mark",
      operations: [
        { operation: "monochrome", channels: ["fill"], color_token: "brand-blue", expected_occurrences: 10 },
        { operation: "copy-metadata", fields: ["metadata_text"] },
        { operation: "copy-accessibility", policy: "preserve" },
      ],
    };
    const traversed = applyRecipeOperations(mono, traversalAsset, tokens, { operation: "build", domain: "brand" }).targetAsset;
    expect((traversed.svg.definitions.polygons[0] as any).fill.color).toBe("#0066CC");
    expect((traversed.svg.definitions.groups[0] as any).children[0].fill.color).toBe("#0066CC");
    expect(traversed.svg.metadataText).toBe("Authoritative metadata");
  });

  it("enforces nested group uniqueness, exact counts, geometry, retain membership, and generated ID collisions", () => {
    const tokens = unwrap(parseBrandTokensToml(TOKENS_TOML));
    const source = unwrap(parseAssetTomlV2(SOURCE_ASSET_TOML));
    (source.svg.elements[0] as any).children.push({ type: "group", id: "nested-only", children: [] });
    const removeNested: BrandRecipe = {
      id: "remove-nested", source_asset: "source-mark", target_asset: "target-nested",
      operations: [{ operation: "remove-group", group_id: "nested-only" }, { operation: "copy-accessibility", policy: "preserve" }],
    };
    const removed = applyRecipeOperations(removeNested, source, tokens, { operation: "build", domain: "brand" }).targetAsset;
    expect((removed.svg.elements[0] as any).children.some((child: any) => child.id === "nested-only")).toBe(false);

    (source.svg.definitions.groups as any[]).push({ type: "group", id: "definition-parent", children: [{ type: "group", id: "nested-only", children: [] }] });
    expect(() => applyRecipeOperations(removeNested, source, tokens, { operation: "build", domain: "brand" })).toThrow();
    const retainMissing: BrandRecipe = {
      id: "retain-missing", source_asset: "source-mark", target_asset: "target-retain",
      operations: [{ operation: "retain-groups", group_ids: ["missing-group"], expected_before_count: 2, expected_after_count: 1 }, { operation: "copy-accessibility", policy: "preserve" }],
    };
    expect(() => applyRecipeOperations(retainMissing, source, tokens, { operation: "build", domain: "brand" })).toThrow();
    const countMismatch: BrandRecipe = {
      id: "count-mismatch", source_asset: "source-mark", target_asset: "target-count",
      operations: [{ operation: "monochrome", channels: ["fill"], color_token: "brand-blue", expected_occurrences: 99 }, { operation: "copy-accessibility", policy: "preserve" }],
    };
    expect(() => applyRecipeOperations(countMismatch, source, tokens, { operation: "build", domain: "brand" })).toThrow();
    const badPlate: BrandRecipe = {
      id: "bad-plate", source_asset: "source-mark", target_asset: "target-plate",
      operations: [{ operation: "background-plate", color_token: "brand-dark", element_id: "plate", corner_radius: 13 }, { operation: "copy-accessibility", policy: "preserve" }],
    };
    expect(() => applyRecipeOperations(badPlate, source, tokens, { operation: "build", domain: "brand" })).toThrow();

    const collisionSource = unwrap(parseAssetTomlV2(SOURCE_ASSET_TOML));
    (collisionSource.svg.elements as any[]).push({ type: "group", id: "tfsb-target-access-title", children: [] });
    const accessCollision: BrandRecipe = {
      id: "access-collision", source_asset: "source-mark", target_asset: "target-access",
      operations: [{ operation: "copy-accessibility", policy: "preserve" }],
    };
    expect(() => applyRecipeOperations(accessCollision, collisionSource, tokens, { operation: "build", domain: "brand" })).toThrow();
  });

  it("creates, serializes, and parses derived receipts with valid self-digest", () => {
    const receipt = createBrandDerivedReceipt({
      targetAssetId: "target-mark-dark",
      targetFilename: "target-mark-dark.svg",
      recipeId: "derive-dark-variant",
      recipeFileDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      recipeDefinitionDigest: computeBrandRecipeDefinitionDigest(RECEIPT_RECIPE),
      orderedOperations: toBrandRecipeOperationsCanonicalDto(RECEIPT_RECIPE),
      orderedOperationsDigest: computeBrandRecipeOperationsDigest(RECEIPT_RECIPE),
      tokenFileDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      usedTokens: [
        { id: "brand-blue", type: "color", canonicalValue: "#0066CCFF" },
      ],
      sourceChain: [
        { assetId: "source-mark", canonicalAssetDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444" },
      ],
      targetSchemaVersion: 2,
      targetTomlByteDigest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      targetModelDigest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
      targetSvgDigest: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
      accessibilityPolicy: "preserve",
      accessibilityResult: { mode: "labelled", title: "Target Title" },
      resourceCounts: { operationCount: 1, elementCount: 2 },
    });

    expect(receipt.schema).toBe("tfsb.derived-receipt");
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const serialized = serializeBrandDerivedReceipt(receipt);
    const parsed = unwrap(parseBrandDerivedReceipt(serialized, ".tfsb/derived/target-mark-dark.receipt.json"));
    expect(parsed.receiptDigest).toBe(receipt.receiptDigest);
    expect(parsed.targetAssetId).toBe("target-mark-dark");
    expect(parsed.sourceChain).toHaveLength(1);
    expect(parsed.usedTokens).toHaveLength(1);
  });

  it("rejects corrupted receipt self-digest", () => {
    const receipt = createBrandDerivedReceipt({
      targetAssetId: "target-mark-dark",
      targetFilename: "target-mark-dark.svg",
      recipeId: "derive-dark-variant",
      recipeFileDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      recipeDefinitionDigest: computeBrandRecipeDefinitionDigest(RECEIPT_RECIPE),
      orderedOperations: toBrandRecipeOperationsCanonicalDto(RECEIPT_RECIPE),
      orderedOperationsDigest: computeBrandRecipeOperationsDigest(RECEIPT_RECIPE),
      tokenFileDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      usedTokens: [],
      sourceChain: [
        { assetId: "source-mark", canonicalAssetDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444" },
      ],
      targetSchemaVersion: 2,
      targetTomlByteDigest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      targetModelDigest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
      targetSvgDigest: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
      accessibilityPolicy: "preserve",
      accessibilityResult: { mode: "labelled", title: "Target Title" },
      resourceCounts: { operationCount: 1, elementCount: 2 },
    });

    const tampered = { ...receipt, receiptDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
    const res = parseBrandDerivedReceipt(JSON.stringify(tampered), ".tfsb/derived/target-mark-dark.receipt.json");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.diagnostics[0]!.code).toBe("DERIVED_RECEIPT_INVALID_SELF_DIGEST");
    }
  });

  it("enforces exact receipt size and closed relational parser rules", () => {
    const receipt = createBrandDerivedReceipt({
      targetAssetId: "target-mark-dark",
      targetFilename: "target-mark-dark.svg",
      recipeId: "derive-dark-variant",
      recipeFileDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      recipeDefinitionDigest: computeBrandRecipeDefinitionDigest(RECEIPT_RECIPE),
      orderedOperations: toBrandRecipeOperationsCanonicalDto(RECEIPT_RECIPE),
      orderedOperationsDigest: computeBrandRecipeOperationsDigest(RECEIPT_RECIPE),
      tokenFileDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      usedTokens: [{ id: "brand-blue", type: "color", canonicalValue: "#0066CCFF" }],
      sourceChain: [{ assetId: "source-mark", canonicalAssetDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444" }],
      targetSchemaVersion: 2,
      targetTomlByteDigest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      targetModelDigest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
      targetSvgDigest: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
      accessibilityPolicy: "preserve",
      accessibilityResult: { mode: "labelled", title: "Target Title" },
      resourceCounts: { operationCount: 1, elementCount: 2 },
    });
    const serialized = serializeBrandDerivedReceipt(receipt).trimEnd();
    const boundary = serialized + " ".repeat(DERIVED_RECEIPT_MAX_BYTES - Buffer.byteLength(serialized));
    expect(Buffer.byteLength(boundary)).toBe(DERIVED_RECEIPT_MAX_BYTES);
    expect(parseBrandDerivedReceipt(boundary).ok).toBe(true);
    const above = boundary + " ";
    expect(parseBrandDerivedReceipt(above).ok).toBe(false);

    const altered = (mutate: (value: any) => void): ReturnType<typeof parseBrandDerivedReceipt> => {
      const value = JSON.parse(serializeBrandDerivedReceipt(receipt));
      mutate(value);
      value.receiptDigest = computeDerivedReceiptDigest(value);
      return parseBrandDerivedReceipt(JSON.stringify(value));
    };
    expect(altered((value) => value.usedTokens.push({ ...value.usedTokens[0] })).ok).toBe(false);
    expect(altered((value) => value.sourceChain.push({ ...value.sourceChain[0] })).ok).toBe(false);
    expect(altered((value) => { value.usedTokens[0].type = "opacity"; value.usedTokens[0].canonicalValue = "1000001"; }).ok).toBe(false);
    expect(altered((value) => { value.usedTokens[0].type = "dimension"; value.usedTokens[0].canonicalValue = '{"command":"curl","unit":"px","value":1}'; }).ok).toBe(false);
    expect(altered((value) => { value.accessibilityPolicy = "decorative"; }).ok).toBe(false);
    expect(altered((value) => { value.resourceCounts.operationCount = 2; }).ok).toBe(false);
  });
});
