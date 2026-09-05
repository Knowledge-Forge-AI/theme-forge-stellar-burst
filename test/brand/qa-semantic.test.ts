import { describe, expect, it } from "vitest";

import {
  computeAssetSemanticDigest,
  computeSha256,
  computeSvgOutputDigest,
  parseAssetTomlV2,
  parseBrandQaToml,
  parseBrandRecipesToml,
  parseBrandTokensToml,
  parseBrandToml,
  runBrandQaProfile,
  serializeSvgV2,
  type BrandQaExecutionContext,
  type BrandQaRendererCapability,
} from "../../src/index.js";
import { readRepoFile, unwrap } from "../helpers.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}` as const;

function baseContext(qaSource: string): BrandQaExecutionContext {
  const brand = unwrap(parseBrandToml(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml")));
  const light = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml")));
  const dark = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml")));
  const assets = new Map([[light.id, light], [dark.id, dark]]);
  const svgBytes = new Map([...assets].map(([id, asset]) => [id, Buffer.from(unwrap(serializeSvgV2(asset.svg)), "utf8")]));
  const tokens = unwrap(parseBrandTokensToml(`schema = "tfsb.brand-tokens"
schema_version = 1
[[colors]]
id = "black"
value = "#000000FF"
[[dimensions]]
id = "one-pixel"
unit = "px"
value = 1
`));
  const recipes = unwrap(parseBrandRecipesToml(`schema = "tfsb.brand-recipes"
schema_version = 1
[[recipes]]
id = "derive"
source_asset = "fixture-mark-on-light"
target_asset = "derived-mark"
operations = [{ operation = "copy-accessibility", policy = "preserve" }]
`));
  return { brand, qa: unwrap(parseBrandQaToml(qaSource)), brandSystemDigest: digest("9"), assets, canonicalSvgBytes: svgBytes, tokens, recipes, derived: { entries: [{ targetAssetId: "derived-mark", recipeId: "derive", state: "unchanged", receiptDigest: digest("8"), targetModelDigest: digest("7"), targetSvgDigest: computeSvgOutputDigest(Buffer.from(svgBytes.get(dark.id)!).toString("utf8")) }], counts: { unchanged: 1, "stale-authority": 0, "missing-target": 0, "human-owned": 0, "target-drift": 0, "invalid-receipt": 0, "ownership-conflict": 0 } } };
}

const SEMANTIC = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "semantic"
renderer = "required"
formats = ["json"]
cases = ["inventory", "accessibility", "palette", "external", "embedded", "recipe", "canvas"]
[[cases]]
id = "inventory"
kind = "inventory"
family = "core-fixture"
roles = ["mark"]
[[cases]]
id = "accessibility"
kind = "accessibility"
family = "core-fixture"
require_consistent_labels = false
[[cases]]
id = "palette"
kind = "palette"
asset = "fixture-mark-on-light"
allowed_tokens = ["black"]
allow_literals = false
[[cases]]
id = "external"
kind = "external-reference"
family = "core-fixture"
forbid_external_urls = true
forbid_external_images = true
forbid_external_uses = true
forbid_external_styles = true
forbid_external_fonts = true
[[cases]]
id = "embedded"
kind = "embedded-content"
family = "core-fixture"
forbid_embedded_raster = true
forbid_embedded_fonts = true
[[cases]]
id = "recipe"
kind = "recipe"
recipe = "derive"
verify_provenance = true
verify_receipts = true
[[cases]]
id = "canvas"
kind = "canvas"
family = "core-fixture"
require_viewbox = true
enforce_minimum_size = true
`;

const VISUAL = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "visual"
renderer = "optional"
formats = ["json"]
cases = ["pixels", "transparent", "clip", "padding-px", "padding-token", "padding-ratio", "small"]
[[cases]]
id = "pixels"
kind = "pixel-bounds"
asset = "fixture-mark-on-light"
sizes = [[4, 4]]
backgrounds = ["transparent"]
alpha_threshold = 0
[[cases]]
id = "transparent"
kind = "transparent-bounds"
asset = "fixture-mark-on-light"
sizes = [[4, 4]]
backgrounds = ["transparent"]
alpha_threshold = 0
[[cases]]
id = "clip"
kind = "clipping"
asset = "fixture-mark-on-light"
sizes = [[4, 4]]
backgrounds = ["transparent"]
forbidden_edge_pixels = 1
[[cases]]
id = "padding-px"
kind = "visible-padding"
asset = "fixture-mark-on-light"
sizes = [[4, 4]]
backgrounds = ["transparent"]
minimum_padding_px = 1
[[cases]]
id = "padding-token"
kind = "visible-padding"
asset = "fixture-mark-on-light"
sizes = [[4, 4]]
backgrounds = ["transparent"]
minimum_padding_token = "one-pixel"
[[cases]]
id = "padding-ratio"
kind = "visible-padding"
asset = "fixture-mark-on-light"
sizes = [[4, 4]]
backgrounds = ["transparent"]
minimum_padding_ratio = 250000
[[cases]]
id = "small"
kind = "small-size-visibility"
asset = "fixture-mark-on-light"
sizes = [[4, 4]]
backgrounds = ["transparent"]
minimum_visible_ratio = 62500
`;

const fake: BrandQaRendererCapability = {
  descriptor: { id: "fake", version: "1", qualificationId: "test", platformClaim: "portable" },
  renderSvg(input) { const rgba8 = new Uint8Array(input.width * input.height * 4); rgba8.set([255, 0, 0, 255], (input.width + 1) * 4); return { width: input.width, height: input.height, rgba8 }; },
  decodePng(input) { return { width: input.expectedWidth, height: input.expectedHeight, rgba8: new Uint8Array(input.expectedWidth * input.expectedHeight * 4) }; },
};

describe("semantic and visual brand QA execution", () => {
  it("executes every semantic kind without a renderer", async () => {
    const result = await runBrandQaProfile(baseContext(SEMANTIC), "semantic");
    expect(result.results.map((entry) => entry.kind)).toEqual(["accessibility", "canvas", "embedded-content", "external-reference", "inventory", "palette", "recipe"]);
    expect(result.results.map((entry) => [entry.kind, entry.status])).toEqual(result.results.map((entry) => [entry.kind, "pass"]));
    expect(result.exitCode).toBe(0);
  });

  it("matches alpha-bearing colors and expanded gradient values exactly", async () => {
    const source = SEMANTIC.replace('cases = ["inventory", "accessibility", "palette", "external", "embedded", "recipe", "canvas"]', 'cases = ["palette"]')
      .replace('allowed_tokens = ["black"]', 'allowed_tokens = ["hero-gradient"]');
    const original = baseContext(source);
    const asset = structuredClone(original.assets.get("fixture-mark-on-light")!);
    ((asset.svg as any).presentation as any).fill = { type: "linear-gradient", reference: "hero" };
    (asset.svg.definitions.linearGradients as any[]).push({
      id: "hero", x1: 0, y1: 0, x2: 1, y2: 1,
      stops: [{ offset: 0, color: "#112233", opacity: 128 / 255 }, { offset: 1, color: "#445566" }],
    });
    const tokens = unwrap(parseBrandTokensToml(`schema = "tfsb.brand-tokens"
schema_version = 1
[[gradients]]
id = "hero-gradient"
kind = "linear"
units = "object-bounding-box-millionth"
x1 = 0
y1 = 0
x2 = 1000000
y2 = 1000000
[[gradients.stops]]
offset = 0
color = "#11223380"
[[gradients.stops]]
offset = 1000000
color = "#445566FF"
`));
    const result = await runBrandQaProfile({ ...original, assets: new Map([[asset.id, asset]]), tokens }, "semantic");
    expect(result.exitCode).toBe(0);
    expect(result.results[0]!.status).toBe("pass");
  });

  it("runs all visual metrics from fake RGBA and retains every evaluation", async () => {
    const result = await runBrandQaProfile({ ...baseContext(VISUAL), renderer: fake }, "visual");
    expect(result.exitCode).toBe(0);
    expect(result.counts.pass).toBe(7);
    expect(result.results.every((entry) => entry.evaluations.length === 1)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("rgba8");
  });

  it("makes optional renderer absence exit 0 and required absence exit 3", async () => {
    const optional = await runBrandQaProfile(baseContext(VISUAL), "visual");
    expect(optional.exitCode).toBe(0);
    const required = await runBrandQaProfile(baseContext(VISUAL.replace('renderer = "optional"', 'renderer = "required"')), "visual");
    expect(required.exitCode).toBe(3);
    expect(required.counts.unavailable).toBe(7);
  });

  it("classifies renderer exceptions and malformed buffers as exit 1", async () => {
    const throwing: BrandQaRendererCapability = {
      ...fake,
      renderSvg() {
        throw new Error("Synthetic renderer exception");
      },
    };
    const throwingResult = await runBrandQaProfile({ ...baseContext(VISUAL), renderer: throwing }, "visual");
    expect(throwingResult.exitCode).toBe(1);
    expect(throwingResult.counts.error).toBe(7);

    const malformed: BrandQaRendererCapability = { ...fake, renderSvg(input) { return { width: input.width, height: input.height, rgba8: new Uint8Array(1) }; } };
    const result = await runBrandQaProfile({ ...baseContext(VISUAL), renderer: malformed }, "visual");
    expect(result.exitCode).toBe(1);
    expect(result.counts.error).toBe(7);
  });

  it("enforces exit precedence 3 over 2 when a required renderer is unavailable alongside semantic failure", async () => {
    const mixedQa = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "mixed"
renderer = "required"
formats = ["json"]
cases = ["inv-fail", "pixel-bounds-vis"]
[[cases]]
id = "inv-fail"
kind = "inventory"
family = "nonexistent-family"
roles = ["mark"]
[[cases]]
id = "pixel-bounds-vis"
kind = "pixel-bounds"
asset = "fixture-mark-on-light"
sizes = [[64, 64]]
backgrounds = ["transparent"]
alpha_threshold = 0
`;
    // No renderer provided to a profile with renderer = "required"
    const mixedResult = await runBrandQaProfile(baseContext(mixedQa), "mixed");
    // Required capability unavailable (3) outranks semantic assertion failure (2)
    expect(mixedResult.exitCode).toBe(3);
    expect(mixedResult.counts.fail).toBe(1);
    expect(mixedResult.counts.unavailable).toBe(1);
  });

  it("reports failure and exit 2 for each failing semantic kind and stale/invalid receipts", async () => {
    // 1. Inventory failure (missing family & unbound role & unsatisfied completeness)
    const invQa = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "p"
renderer = "optional"
formats = ["json"]
cases = ["inv-missing-role", "inv-missing-fam"]
[[cases]]
id = "inv-missing-role"
kind = "inventory"
family = "core-fixture"
roles = ["wordmark"]
[[cases]]
id = "inv-missing-fam"
kind = "inventory"
family = "nonexistent-family"
roles = ["mark"]
`;
    const invContext = baseContext(invQa);
    const invResult = await runBrandQaProfile({ ...invContext, completeness: { satisfied: false, familyCount: 1, variantCount: 1, bindingCount: 1, requirementCount: 0 } }, "p");
    expect(invResult.exitCode).toBe(2);
    expect(invResult.counts.fail).toBe(2);
    expect(invResult.results.every((r) => r.status === "fail")).toBe(true);

    // 2. Accessibility failure (inconsistent labels when required, and decorative with title)
    const a11yQa = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "p"
renderer = "optional"
formats = ["json"]
cases = ["a11y-inconsistent"]
[[cases]]
id = "a11y-inconsistent"
kind = "accessibility"
family = "core-fixture"
require_consistent_labels = true
`;
    const a11yContext = baseContext(a11yQa);
    const darkAsset = structuredClone(a11yContext.assets.get("fixture-mark-on-dark")!);
    ((darkAsset.svg as any).accessibility as any).mode = "decorative";
    ((darkAsset.svg as any).accessibility as any).title = "A decorative title";
    const a11yResult = await runBrandQaProfile({ ...a11yContext, assets: new Map([["fixture-mark-on-light", a11yContext.assets.get("fixture-mark-on-light")!], ["fixture-mark-on-dark", darkAsset]]) }, "p");
    expect(a11yResult.exitCode).toBe(2);
    expect(a11yResult.results[0]!.status).toBe("fail");

    // 3. Palette failure (unallowed paint color and unallowed recipe token)
    const paletteQa = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "p"
renderer = "optional"
formats = ["json"]
cases = ["palette-fail"]
[[cases]]
id = "palette-fail"
kind = "palette"
asset = "fixture-mark-on-light"
allowed_tokens = ["nonexistent-token"]
allow_literals = false
`;
    const paletteResult = await runBrandQaProfile(baseContext(paletteQa), "p");
    expect(paletteResult.exitCode).toBe(2);
    expect(paletteResult.results[0]!.status).toBe("fail");

    // 4. External reference failure (external URLs, external styles, external fonts)
    const extQa = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "p"
renderer = "optional"
formats = ["json"]
cases = ["ext-fail"]
[[cases]]
id = "ext-fail"
kind = "external-reference"
family = "core-fixture"
forbid_external_urls = true
forbid_external_images = true
forbid_external_uses = true
forbid_external_styles = true
forbid_external_fonts = true
`;
    const extContext = baseContext(extQa);
    const extSvgBytes = new Map(extContext.canonicalSvgBytes);
    extSvgBytes.set("fixture-mark-on-light", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><link rel="stylesheet" href="https://example.com/style.css"/><use href="http://example.com/icon.svg#test"/><image href="https://example.com/img.png"/></svg>', "utf8"));
    const extResult = await runBrandQaProfile({ ...extContext, canonicalSvgBytes: extSvgBytes }, "p");
    expect(extResult.exitCode).toBe(2);
    expect(extResult.results[0]!.status).toBe("fail");

    // 5. Embedded content failure (data:image/png and data:application/font-woff)
    const embedQa = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "p"
renderer = "optional"
formats = ["json"]
cases = ["embed-fail"]
[[cases]]
id = "embed-fail"
kind = "embedded-content"
family = "core-fixture"
forbid_embedded_raster = true
forbid_embedded_fonts = true
`;
    const embedContext = baseContext(embedQa);
    const embedSvgBytes = new Map(embedContext.canonicalSvgBytes);
    embedSvgBytes.set("fixture-mark-on-light", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo="/><style>@font-face { src: url("data:application/font-woff;base64,d09GRg=="); }</style></svg>', "utf8"));
    const embedResult = await runBrandQaProfile({ ...embedContext, canonicalSvgBytes: embedSvgBytes }, "p");
    expect(embedResult.exitCode).toBe(2);
    expect(embedResult.results[0]!.status).toBe("fail");

    // 6. Recipe failure (stale authority & missing receipt)
    const recipeQa = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "p"
renderer = "optional"
formats = ["json"]
cases = ["recipe-fail"]
[[cases]]
id = "recipe-fail"
kind = "recipe"
recipe = "derive"
verify_provenance = true
verify_receipts = true
`;
    const recipeContext = baseContext(recipeQa);
    const recipeResult = await runBrandQaProfile({
      ...recipeContext,
      derived: {
        entries: [{ targetAssetId: "derived-mark", recipeId: "derive", state: "stale-authority", receiptDigest: digest("8"), targetModelDigest: digest("7"), targetSvgDigest: digest("6") }],
        counts: { unchanged: 0, "stale-authority": 1, "missing-target": 0, "human-owned": 0, "target-drift": 0, "invalid-receipt": 0, "ownership-conflict": 0 },
      },
    }, "p");
    expect(recipeResult.exitCode).toBe(2);
    expect(recipeResult.results[0]!.status).toBe("fail");

    // 7. Canvas failure (missing/invalid viewBox and size below minimum)
    const canvasQa = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "p"
renderer = "optional"
formats = ["json"]
cases = ["canvas-fail"]
[[cases]]
id = "canvas-fail"
kind = "canvas"
asset = "fixture-mark-on-light"
require_viewbox = true
enforce_minimum_size = true
`;
    const canvasContext = baseContext(canvasQa);
    const tinyAsset = structuredClone(canvasContext.assets.get("fixture-mark-on-light")!);
    (tinyAsset.svg as any).canvas = { width: 1, height: 1 };
    const canvasResult = await runBrandQaProfile({ ...canvasContext, assets: new Map([["fixture-mark-on-light", tinyAsset]]) }, "p");
    expect(canvasResult.exitCode).toBe(2);
    expect(canvasResult.results[0]!.status).toBe("fail");
  });

  it("executes visual baseline cases reporting equality, difference, descriptor mismatch, and stale inputs", async () => {
    const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml")));
    const assetDigest = computeAssetSemanticDigest(asset);
    const svgText = unwrap(serializeSvgV2(asset.svg));
    const svgBytes = Buffer.from(svgText, "utf8");
    const svgDigest = computeSvgOutputDigest(svgText);
    const pngBytes = new Uint8Array([10, 80, 78, 71]);
    const pngDigest = computeSha256(pngBytes);

    const baselineToml = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "visual-baseline"
renderer = "required"
formats = ["json"]
cases = ["golden"]
[[cases]]
id = "golden"
kind = "baseline"
asset = "fixture-mark-on-light"
sizes = [[2, 2]]
backgrounds = ["transparent"]
baseline_path = ".tfsb/brand-baselines/visual-baseline/golden.png"
baseline_digest = "${pngDigest}"
renderer_id = "fake"
renderer_version = "1"
platform_claim = "portable"
canonical_asset_digest = "${assetDigest}"
svg_digest = "${svgDigest}"
`;
    const context = baseContext(baselineToml);
    const baselineFiles = new Map([[".tfsb/brand-baselines/visual-baseline/golden.png", pngBytes]]);

    // Exact match -> pass
    const matchingRenderer: BrandQaRendererCapability = {
      descriptor: { id: "fake", version: "1", qualificationId: "test", platformClaim: "portable" },
      renderSvg(input) { return { width: input.width, height: input.height, rgba8: new Uint8Array(input.width * input.height * 4), pngBytes }; },
      decodePng(input) { return { width: input.expectedWidth, height: input.expectedHeight, rgba8: new Uint8Array(input.expectedWidth * input.expectedHeight * 4) }; },
    };
    const passResult = await runBrandQaProfile({ ...context, baselineFiles, renderer: matchingRenderer }, "visual-baseline");
    expect(passResult.exitCode).toBe(0);
    expect(passResult.counts.pass).toBe(1);
    expect(passResult.results[0]!.evaluations[0]!.measurements.claim).toBe("pixel-equal-for-this-renderer-and-case-only");

    // Pixel difference -> fail (exit 2)
    const diffRenderer: BrandQaRendererCapability = {
      descriptor: { id: "fake", version: "1", qualificationId: "test", platformClaim: "portable" },
      renderSvg(input) {
        const rgba8 = new Uint8Array(input.width * input.height * 4);
        rgba8[0] = 255;
        return { width: input.width, height: input.height, rgba8, pngBytes };
      },
      decodePng(input) { return { width: input.expectedWidth, height: input.expectedHeight, rgba8: new Uint8Array(input.expectedWidth * input.expectedHeight * 4) }; },
    };
    const failResult = await runBrandQaProfile({ ...context, baselineFiles, renderer: diffRenderer }, "visual-baseline");
    expect(failResult.exitCode).toBe(2);
    expect(failResult.counts.fail).toBe(1);
    expect(failResult.results[0]!.evaluations[0]!.measurements.claim).toBe("pixel-different-for-this-renderer-and-case-only");

    // Renderer descriptor mismatch -> unavailable (exit 3 when required)
    const mismatchRenderer: BrandQaRendererCapability = {
      descriptor: { id: "other-renderer", version: "2", qualificationId: "test", platformClaim: "portable" },
      renderSvg(input) { return { width: input.width, height: input.height, rgba8: new Uint8Array(input.width * input.height * 4) }; },
      decodePng(input) { return { width: input.expectedWidth, height: input.expectedHeight, rgba8: new Uint8Array(input.expectedWidth * input.expectedHeight * 4) }; },
    };
    const unavailResult = await runBrandQaProfile({ ...context, baselineFiles, renderer: mismatchRenderer }, "visual-baseline");
    expect(unavailResult.exitCode).toBe(3);
    expect(unavailResult.counts.unavailable).toBe(1);

    // Missing baseline PNG -> error (exit 1)
    const missingPngResult = await runBrandQaProfile({ ...context, baselineFiles: new Map(), renderer: matchingRenderer }, "visual-baseline");
    expect(missingPngResult.exitCode).toBe(1);
    expect(missingPngResult.counts.error).toBe(1);

    // Stale baseline digest -> error (exit 1)
    const staleBaselineFiles = new Map([[".tfsb/brand-baselines/visual-baseline/golden.png", new Uint8Array([99, 99])]]);
    const staleResult = await runBrandQaProfile({ ...context, baselineFiles: staleBaselineFiles, renderer: matchingRenderer }, "visual-baseline");
    expect(staleResult.exitCode).toBe(1);
    expect(staleResult.counts.error).toBe(1);
  });
});
