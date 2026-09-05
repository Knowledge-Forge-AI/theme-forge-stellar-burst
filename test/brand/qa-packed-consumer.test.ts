import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("packed brand QA and diff consumer", () => {
  it("exports schema, reports, semantic QA, unavailable policy, visual diff, brand diff, and checks export inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-qa-packed-")); roots.push(root);
    const packDestination = join(root, "pack");
    await mkdir(packDestination, { recursive: true });
    const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packDestination], { cwd: process.cwd(), encoding: "utf8" })) as [{ filename: string }];
    const packageRoot = join(root, "node_modules", "@knowledge-forge-ai", "theme-forge-stellar-burst");
    await mkdir(packageRoot, { recursive: true });
    execFileSync("tar", ["-xzf", join(packDestination, filename), "--strip-components=1", "-C", packageRoot]);
    for (const dependency of ["@xmldom", "fflate", "smol-toml"]) {
      const source = join(process.cwd(), "node_modules", dependency), target = join(root, "node_modules", dependency);
      if (existsSync(source) && !existsSync(target)) await symlink(source, target);
    }
    const qaToml = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "optional-profile"
renderer = "optional"
formats = ["json", "markdown", "html"]
cases = ["inventory", "pixels"]
[[profiles]]
id = "required-profile"
renderer = "required"
formats = ["json"]
cases = ["pixels"]
[[cases]]
id = "inventory"
kind = "inventory"
family = "core"
[[cases]]
id = "pixels"
kind = "pixel-bounds"
asset = "mark"
sizes = [[4, 4]]
backgrounds = ["transparent"]
alpha_threshold = 0
`;
    const brandToml = `schema = "tfsb.brand"
schema_version = 1
enabled_domains = { tokens = false, recipes = false, qa = true, consumer_profiles = false, package = false, exports = false }
[[families]]
id = "core"
name = "Core"
required_roles = []
optional_roles = []
[[variants]]
family = "core"
id = "default"
backgrounds = ["any"]
color_mode = "full-color"
scale = "standard"
status = "primary"
[[bindings]]
family = "core"
role = "mark"
variant = "default"
asset = "mark"
authority = "source"
`;
    const code = `
import assert from "node:assert/strict";
import * as api from "@knowledge-forge-ai/theme-forge-stellar-burst";

// 1. Schema parsing and digests
const parsedQa = api.parseBrandQaToml(${JSON.stringify(qaToml)});
assert.equal(parsedQa.ok, true);
const qaDigest = api.computeBrandQaDigest(parsedQa.value);
assert.ok(qaDigest.startsWith("sha256:"));

const parsedBrand = api.parseBrandToml(${JSON.stringify(brandToml)});
assert.equal(parsedBrand.ok, true);

// 2. Semantic QA execution without renderer
const asset = {
  id: "mark",
  filename: "mark.svg",
  title: "Mark",
  svg: {
    canvas: { width: 10, height: 10, viewBox: [0, 0, 10, 10] },
    accessibility: { mode: "decorative" },
    definitions: { clipPaths: [], linearGradients: [], masks: [] },
    elements: [],
  },
};
const context = {
  brand: parsedBrand.value,
  qa: parsedQa.value,
  brandSystemDigest: "sha256:" + "0".repeat(64),
  assets: new Map([["mark", asset]]),
  canonicalSvgBytes: new Map([["mark", Buffer.from('<svg viewBox="0 0 10 10"/>', "utf8")]]),
};

// 3. Optional visual without renderer -> exits 0
const optResult = await api.runBrandQaProfile(context, "optional-profile");
assert.equal(optResult.exitCode, 0);
assert.equal(optResult.counts.pass, 1);
assert.equal(optResult.counts.unavailable, 1);

// 4. Required visual without renderer -> exits 3
const reqResult = await api.runBrandQaProfile(context, "required-profile");
assert.equal(reqResult.exitCode, 3);
assert.equal(reqResult.counts.unavailable, 1);

// 5. Visual diff with fake renderer
const renderer = {
  descriptor: { id: "fake", version: "1", qualificationId: "packed", platformClaim: "portable" },
  renderSvg(input) {
    const rgba8 = new Uint8Array(input.width * input.height * 4);
    rgba8[3] = input.canonicalSvgBytes[0];
    return { width: input.width, height: input.height, rgba8 };
  },
  decodePng(input) {
    return { width: input.expectedWidth, height: input.expectedHeight, rgba8: new Uint8Array(input.expectedWidth * input.expectedHeight * 4) };
  },
};
const dummyDigest = "sha256:" + "1".repeat(64);
const equal = await api.compareBrandVisuals({
  caseId: "packed",
  target: "mark",
  before: { canonicalAssetDigest: dummyDigest, modelDigest: dummyDigest, svgDigest: dummyDigest, canonicalSvgBytes: new Uint8Array([255]) },
  after: { canonicalAssetDigest: dummyDigest, modelDigest: dummyDigest, svgDigest: dummyDigest, canonicalSvgBytes: new Uint8Array([255]) },
  renderer,
  width: 1,
  height: 1,
  background: "transparent",
  backgroundRgba: null,
});
assert.equal(equal.claim, "pixel-equal-for-this-renderer-and-case-only");

// 6. Brand semantic diff
const snapshot1 = {
  digest: "sha256:" + "0".repeat(64),
  brand: {
    model: parsedBrand.value,
    qaModel: parsedQa.value,
    brandSystemDigest: "sha256:" + "0".repeat(64),
  },
  assets: new Map([["mark", asset]]),
  companions: new Map(),
};
const snapshot2 = structuredClone(snapshot1);
const diffResult = api.compareBrandSnapshots(snapshot1, snapshot2);
assert.equal(diffResult.status, "equal");
assert.ok(diffResult.resultDigest.startsWith("sha256:"));

// 7. Report projections
const md = api.projectBrandQaResultMarkdown(optResult);
assert.ok(md.includes("# Brand QA result"));
const html = api.projectBrandQaResultHtml(optResult);
assert.ok(html.includes("<!doctype html>"));
assert.ok(html.includes("Content-Security-Policy"));

// 8. Public export inventory & privacy assertions
const expectedExports = [
  "BRAND_QA_SCHEMA_ID", "BRAND_QA_SCHEMA_VERSION", "BRAND_QA_DIGEST_BASIS",
  "BRAND_QA_MAX_BYTES", "BRAND_QA_MAX_PROFILES", "BRAND_QA_MAX_CASES", "BRAND_QA_MAX_VISUAL_CASES",
  "BRAND_QA_FORMATS", "BRAND_QA_SEMANTIC_KINDS", "BRAND_QA_VISUAL_KINDS",
  "parseBrandQaToml", "toBrandQaCanonicalDto", "serializeBrandQaToml", "computeBrandQaDigest",
  "BRAND_QA_RENDER_CONFIGURATION", "validateBrandQaRendererDescriptor", "parseBrandQaBackgroundRgba",
  "renderBrandQaRaster", "decodeBrandQaBaseline", "measureBrandQaRaster", "compareBrandQaRasters",
  "BRAND_QA_RESULT_SCHEMA", "computeBrandQaExitCode", "computeBrandQaResultDigest", "createBrandQaResult",
  "serializeBrandQaResult", "projectBrandQaResultMarkdown", "projectBrandQaResultHtml",
  "runBrandQaProfile", "runBrandQaSemanticProfile", "runLoadedBrandQaProfile",
  "planBrandQaBaselineUpdate", "executeBrandQaBaselineUpdatePlan", "disposeBrandQaBaselineUpdatePlan",
  "BRAND_DIFF_SCHEMA", "createBrandDiffSnapshot", "createLoadedProjectBrandDiffSnapshot",
  "computeBrandDiffResultDigest", "compareBrandSnapshots", "serializeBrandDiff", "projectBrandDiffMarkdown", "projectBrandDiffHtml",
  "BRAND_VISUAL_DIFF_SCHEMA", "computeBrandVisualDiffResultDigest", "compareBrandVisuals", "serializeBrandVisualDiff",
];
for (const name of expectedExports) {
  assert.ok(name in api, "Expected export " + name + " is present in package API");
}

// Ensure private internals are not leaked
const forbiddenNames = [
  "loadBrandProject", "discoverBrandState", "brandImportInternals", "baselinePlanInternals",
  "validateExactStagedTree", "resolveTargets", "semanticCase", "visualCase",
];
for (const name of forbiddenNames) {
  assert.equal(name in api, false, "Private symbol " + name + " must not be exported");
}

console.log("QA_PACKED_OK");
`;
    await writeFile(join(root, "consumer.mjs"), code);
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    const output = execFileSync(process.execPath, [join(root, "consumer.mjs")], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") } });
    expect(output).toContain("QA_PACKED_OK");
  }, 30_000);
});
