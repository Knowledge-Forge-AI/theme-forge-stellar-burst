import { describe, expect, it } from "vitest";

import { compareBrandSnapshots, parseAssetTomlV2, parseBrandQaToml, parseBrandRecipesToml, parseBrandTokensToml, parseBrandToml, projectBrandDiffHtml, projectBrandDiffMarkdown, serializeBrandDiff, type BrandDiffSnapshot } from "../../src/index.js";
import { readRepoFile, unwrap } from "../helpers.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}` as const;

function snapshot(changed: boolean): BrandDiffSnapshot {
  const model = unwrap(parseBrandToml(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml")));
  const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml")));
  const tokens = unwrap(parseBrandTokensToml(`schema = "tfsb.brand-tokens"
schema_version = 1
[[colors]]
id = "black"
value = "${changed ? "#111111FF" : "#000000FF"}"
[[gradients]]
id = "fade"
kind = "linear"
units = "object-bounding-box-millionth"
x1 = 0
y1 = 0
x2 = 1000000
y2 = 1000000
stops = [{ offset = 0, color_token = "black" }, { offset = 1000000, color = "${changed ? "#FFFFFFFF" : "#EEEEEEFF"}" }]
`));
  const recipes = unwrap(parseBrandRecipesToml(`schema = "tfsb.brand-recipes"
schema_version = 1
[[recipes]]
id = "derive"
source_asset = "fixture-mark-on-light"
target_asset = "derived-mark"
operations = [${changed ? '{ operation = "copy-metadata", fields = ["metadata_text"] }, ' : ""}{ operation = "copy-accessibility", policy = "preserve" }]
`));
  const qa = unwrap(parseBrandQaToml(`schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "qa"
renderer = "optional"
formats = ["json"]
cases = ["canvas"]
[[cases]]
id = "canvas"
kind = "canvas"
asset = "fixture-mark-on-light"
require_viewbox = true
enforce_minimum_size = ${changed}
`));
  const geometryAsset = changed ? { ...asset, svg: { ...asset.svg, canvas: { ...asset.svg.canvas, width: 25 } } } : asset;
  const domains = [
    { domain: "brand", canonicalPath: ".tfsb/brand.toml", enabled: true, state: "available", present: true },
    { domain: "tokens", canonicalPath: ".tfsb/brand-tokens.toml", enabled: true, state: "available", present: true },
    { domain: "recipes", canonicalPath: ".tfsb/brand-recipes.toml", enabled: true, state: "available", present: true },
    { domain: "qa", canonicalPath: ".tfsb/brand-qa.toml", enabled: true, state: "available", present: true },
    { domain: "consumer_profiles", canonicalPath: ".tfsb/consumer-profiles.toml", enabled: false, state: "disabled", present: false },
    { domain: "exports", canonicalPath: ".tfsb/brand-exports.toml", enabled: false, state: "disabled", present: false },
  ] as const;
  const brand = { model, tokensModel: tokens, recipesModel: recipes, qaModel: qa, brandDigest: digest("1"), tokensDigest: digest("2"), recipesDigest: digest("3"), qaDigest: digest("4"), brandSystemDigest: changed ? digest("9") : digest("8"), domains, brandFiles: new Map(), referencedAssets: [], completeness: { satisfied: true, familyCount: 1, variantCount: 2, bindingCount: 2, requirementCount: 2 } };
  return { digest: brand.brandSystemDigest, brand, assets: new Map([[asset.id, geometryAsset as typeof asset]]), companions: new Map(changed ? [["GUIDANCE.md", new Uint8Array([2])]] : [["GUIDANCE.md", new Uint8Array([1])]]), derived: { entries: [{ targetAssetId: "derived-mark", recipeId: "derive", state: changed ? "stale-authority" : "unchanged", receiptDigest: digest(changed ? "7" : "6") }], counts: { unchanged: changed ? 0 : 1, "stale-authority": changed ? 1 : 0, "missing-target": 0, "human-owned": 0, "target-drift": 0, "invalid-receipt": 0, "ownership-conflict": 0 } } };
}

describe("brand semantic diff", () => {
  it("produces all ten closed sections in deterministic order with complete typed changes", () => {
    const result = compareBrandSnapshots(snapshot(false), snapshot(true));
    expect(result.status).toBe("changed");
    expect(result.tokens.records[0]).toMatchObject({ id: "black", change: "changed" });
    expect(result.tokens.records.find((entry) => entry.id === "fade")?.after).toMatchObject({ stops: [{ colorToken: "black", offset: 0 }, { color: "#FFFFFFFF", offset: 1000000 }] });
    expect(result.recipes.records[0]).toMatchObject({ id: "derive", change: "changed" });
    expect(result.derived.records[0]).toMatchObject({ id: "derived-mark", change: "changed" });
    expect(result.geometry.canonicalTypedGeometryChanged).toBe(true);
    expect(result.geometry.equivalenceClaim).toBe("none");
    expect(result.qaImpact.affectedCases).toEqual(["canvas"]);
    expect(result.consumerProfiles.status).toBe("unavailable");
    expect(result.exports.status).toBe("unavailable");
    const json = serializeBrandDiff(result);
    const positions = ["inventory", "bindings", "tokens", "recipes", "derived", "geometry", "qaImpact", "packageAndLegal", "consumerProfiles", "exports"].map((section) => json.indexOf(`"${section}"`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(serializeBrandDiff(result)).toBe(json);
  });

  it("returns equal for identical snapshots and deterministic escaped reports", () => {
    const before = snapshot(false);
    const result = compareBrandSnapshots(before, before);
    expect(result.status).toBe("equal");
    expect(result.geometry.canonicalTypedGeometryChanged).toBe(false);
    const markdown = projectBrandDiffMarkdown(result);
    const html = projectBrandDiffHtml(result);
    expect(markdown).toContain("## inventory");
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toMatch(/<script|\son[a-z]+\s*=|https?:|data:/iu);
  });

  it("keeps the documented semantic diff on the executable digest contract", () => {
    expect(() => serializeBrandDiff(JSON.parse(readRepoFile("docs/examples/v0.4/brand-system/results/brand-semantic-diff.json")))).not.toThrow();
  });
});
