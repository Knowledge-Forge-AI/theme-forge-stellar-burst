import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";

import { afterEach, describe, expect, it } from "vitest";

import {
  BRAND_FILE_INVENTORY,
  bundleProject,
  executeAssetEdit,
  executeFormat,
  executeMigration,
  importProject,
  loadCanonicalProject,
  planAssetEdit,
  planFormat,
  planMigration,
  reconcileDirectoryProject,
  reconcileProject,
  computeConsumerProfilesDomainDigest,
  computeBrandExportsDomainDigest,
  parseBrandExportsToml,
  parseConsumerProfilesToml,
} from "../../src/index.js";
import { getDirectorySnapshotCapability } from "../../src/directory-snapshot.js";
import { executeCanonicalTransaction, snapshotCanonicalTree } from "../../src/transaction.js";
import { parseAssetTomlV2 } from "../../src/schema2-toml.js";
import { serializeSvgV2 } from "../../src/schema2-svg.js";
import { readArchive } from "../../src/archive.js";
import { readRepoFile, unwrap } from "../helpers.js";

const roots: string[] = [];
const nativeAvailable = getDirectorySnapshotCapability(realpathSync(tmpdir())).supported;

function sourceSvg(pathData = "M0 0L1 1"): string {
  const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml"))).svg;
  const path = { type: "path", d: pathData } as unknown as (typeof asset.elements)[number];
  return unwrap(serializeSvgV2({ ...asset, elements: [...asset.elements, path] }));
}

afterEach(async () => {
  for (const root of roots.splice(0, roots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

const PROJECT = `schema_version = 1
name = "Brand preservation fixture"

[build]
directory = "dist"
`;

const ALPHA = `schema_version = 1
id = "alpha"
filename = "alpha.svg"

[canvas]
view_box = "0 0 10 10"

[accessibility]
title = "Alpha"
title_id = "alpha-title"
description = "Alpha icon"
description_id = "alpha-description"

[[elements]]
type = "path"
d = "M0 0 L10 10"
`;

const BETA = ALPHA.replaceAll("alpha", "beta").replaceAll("Alpha", "Beta");
const PROVENANCE = Buffer.from(
  JSON.stringify({
    kind: "tfsb-import-provenance",
    schemaVersion: 1,
    records: [],
  }) + "\n",
  "utf8",
);
const COMPANION = Buffer.from("companion bytes must remain unchanged\n", "utf8");

const BRAND_TOML = `# Custom comments to ensure exact byte preservation
schema = "tfsb.brand"
schema_version = 1
enabled_domains = { tokens = true, recipes = true, qa = true, consumer_profiles = true, package = true, exports = true }

[[families]]
id = "fixture-fam"
name = "Fixture Family"
required_roles = []
optional_roles = ["mark"]

[[variants]]
family = "fixture-fam"
id = "std"
backgrounds = ["any"]
color_mode = "full-color"
scale = "standard"
status = "primary"

[[bindings]]
family = "fixture-fam"
role = "mark"
variant = "std"
asset = "alpha"
authority = "source"
`;

const BRAND_TOKENS = Buffer.from(`# Brand tokens file
schema = "tfsb.brand-tokens"
schema_version = 1

[[colors]]
id = "primary"
value = "#000000FF"
`, "utf8");
const BRAND_RECIPES = Buffer.from(`# Brand recipes file
schema = "tfsb.brand-recipes"
schema_version = 1
recipes = []
`, "utf8");
const BRAND_QA = Buffer.from(`# Brand QA file
schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "preservation"
renderer = "optional"
formats = ["json"]
cases = ["inventory"]
[[cases]]
id = "inventory"
kind = "inventory"
family = "fixture-fam"
`, "utf8");
const CONSUMER_PROFILES = Buffer.from(`# Consumer profiles file
schema = "tfsb.consumer-profiles"
schema_version = 1
[[profiles]]
id = "preservation"
version = 1
compatible_package = "fixture-pkg"
[[profiles.outputs]]
asset = "alpha"
destination = "public/alpha.svg"
requirement = "required"
collision = "error"
`, "utf8");
const CONSUMER_PROFILE_MODEL = parseConsumerProfilesToml(CONSUMER_PROFILES.toString("utf8"));
if (!CONSUMER_PROFILE_MODEL.ok) throw new Error("Consumer profile preservation fixture is invalid.");
const CONSUMER_PROFILE_DIGEST = computeConsumerProfilesDomainDigest(CONSUMER_PROFILE_MODEL.value);
const BRAND_EXPORTS = Buffer.from(`# Brand exports file
schema = "tfsb.brand-exports"
schema_version = 1
[[profiles]]
id = "preservation"
adapter = "resvg-png-v1"
[[profiles.outputs]]
id = "alpha"
purpose = "png"
asset = "alpha"
destination = "public/preservation.png"
width = 1
height = 1
fit = "contain-pad"
background = "transparent"
color_space = "srgb"
alpha = "straight"
`, "utf8");
const BRAND_EXPORT_MODEL = parseBrandExportsToml(BRAND_EXPORTS.toString("utf8"));
if (!BRAND_EXPORT_MODEL.ok) throw new Error("Brand export preservation fixture is invalid.");
const BRAND_EXPORT_DIGEST = computeBrandExportsDomainDigest(BRAND_EXPORT_MODEL.value);
const BRAND_PACKAGE = Buffer.from(`schema = "tfsb.brand-package"
schema_version = 1
package_id = "fixture-pkg"
name = "Fixture Package"
brand_version = "1.0.0"
families = ["fixture-fam"]
compatible_profiles = ["preservation"]
brand_system_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
consumer_profile_digest = "${CONSUMER_PROFILE_DIGEST}"
export_profile_digest = "${BRAND_EXPORT_DIGEST}"

[[inventory]]
family = "fixture-fam"
role = "mark"
variant = "std"
asset = "alpha"
canonical_asset_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
svg_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
`, "utf8");
const CONSUMER_LOCK = Buffer.from(readRepoFile("docs/examples/v0.4/brand-system/consumer/.tfsb/brand.lock.json"), "utf8");

async function createBrandedFixture(): Promise<{ readonly root: string; readonly brandFilesBefore: ReadonlyMap<string, Buffer> }> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-brand-preservation-"));
  roots.push(root);

  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
  await mkdir(join(root, ".tfsb", "companions"), { recursive: true });
  await writeFile(join(root, ".tfsb", "project.toml"), PROJECT);
  await writeFile(join(root, ".tfsb", "assets", "alpha.toml"), ALPHA);
  await writeFile(join(root, ".tfsb", "assets", "beta.toml"), BETA);
  await writeFile(join(root, ".tfsb", "companions", "README.md"), COMPANION);
  await writeFile(join(root, ".tfsb", "provenance.json"), PROVENANCE);

  // Write all 7 brand files
  await writeFile(join(root, ".tfsb", "brand.toml"), BRAND_TOML);
  await writeFile(join(root, ".tfsb", "brand-tokens.toml"), BRAND_TOKENS);
  await writeFile(join(root, ".tfsb", "brand-recipes.toml"), BRAND_RECIPES);
  await writeFile(join(root, ".tfsb", "brand-qa.toml"), BRAND_QA);
  await writeFile(join(root, ".tfsb", "consumer-profiles.toml"), CONSUMER_PROFILES);
  await writeFile(join(root, ".tfsb", "brand-package.toml"), BRAND_PACKAGE);
  await writeFile(join(root, ".tfsb", "brand-exports.toml"), BRAND_EXPORTS);
  await writeFile(join(root, ".tfsb", "brand.lock.json"), CONSUMER_LOCK);

  const brandFilesBefore = new Map<string, Buffer>();
  for (const entry of BRAND_FILE_INVENTORY) {
    brandFilesBefore.set(entry.canonicalPath, await readFile(join(root, entry.canonicalPath)));
  }
  brandFilesBefore.set(".tfsb/brand.lock.json", await readFile(join(root, ".tfsb", "brand.lock.json")));

  return { root, brandFilesBefore };
}

async function assertBrandFilesPreserved(root: string, before: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const [path, expectedBytes] of before) {
    const actualBytes = await readFile(join(root, path));
    expect(Buffer.compare(actualBytes, expectedBytes)).toBe(0);
  }
}

describe("brand whole-tree preservation across all mutations", () => {
  it("preserves all 7 fixed brand files and the consumer lock byte-for-byte across fmt", async () => {
    const { root, brandFilesBefore } = await createBrandedFixture();
    const plan = await planFormat(root);
    await executeFormat(plan);
    await assertBrandFilesPreserved(root, brandFilesBefore);
  });

  it("preserves all 7 fixed brand files and the consumer lock byte-for-byte across editAsset", async () => {
    const { root, brandFilesBefore } = await createBrandedFixture();
    const plan = await planAssetEdit({
      root,
      assetId: "beta",
      proposedToml: BETA.replace('title = "Beta"', 'title = "Updated Beta"'),
    });
    await executeAssetEdit(plan);
    await assertBrandFilesPreserved(root, brandFilesBefore);
  });

  it("preserves all 7 fixed brand files and the consumer lock byte-for-byte across schema migration", async () => {
    const { root, brandFilesBefore } = await createBrandedFixture();
    const plan = await planMigration({ root });
    await executeMigration(plan);
    await assertBrandFilesPreserved(root, brandFilesBefore);
  });

  it("preserves all 7 fixed brand files byte-for-byte across archive reconciliation", async () => {
    const { root, brandFilesBefore } = await createBrandedFixture();
    const archivePath = join(root, "input.zip");
    const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-labelledby="alpha-title alpha-desc"><title id="alpha-title">Alpha</title><desc id="alpha-desc">Alpha icon</desc><path d="M0 0 L10 10"/></svg>';
    const zipBytes = zipSync({
      "alpha.svg": [Buffer.from(validSvg), {}],
    });
    await writeFile(archivePath, zipBytes);

    await reconcileProject({
      root,
      archive: archivePath,
      apply: true,
    });

    await assertBrandFilesPreserved(root, brandFilesBefore);
  });

  it.runIf(nativeAvailable)("preserves all 7 fixed brand files byte-for-byte across directory reconciliation", async () => {
    const base = realpathSync(await mkdtemp(join(tmpdir(), "tfsb-brand-dir-reconcile-")));
    roots.push(base);
    const source = join(base, "source");
    const root = join(base, "project");
    await mkdir(join(source, "icons"), { recursive: true });
    await mkdir(root);
    await writeFile(join(source, "icons", "alpha.svg"), sourceSvg("M0 0L1 1"));
    const sourceMap = `schema_version = 1\nsource_root = "."\n\n[[collection]]\nid = "icons"\nname = "Icons"\nroot = "icons"\nidentity = "basename"\nprefix = ""\ninclude_paths = []\ninclude_trees = ["."]\nexclude_paths = []\nexclude_trees = []\n`;
    await writeFile(join(source, ".tfsb-source-map.toml"), sourceMap);

    await importProject({
      source: { kind: "directory", path: source },
      root,
      collections: ["icons"],
    });

    // Write all 7 brand files
    await writeFile(join(root, ".tfsb", "brand.toml"), BRAND_TOML);
    await writeFile(join(root, ".tfsb", "brand-tokens.toml"), BRAND_TOKENS);
    await writeFile(join(root, ".tfsb", "brand-recipes.toml"), BRAND_RECIPES);
    await writeFile(join(root, ".tfsb", "brand-qa.toml"), BRAND_QA);
    await writeFile(join(root, ".tfsb", "consumer-profiles.toml"), CONSUMER_PROFILES);
    await writeFile(join(root, ".tfsb", "brand-package.toml"), BRAND_PACKAGE);
    await writeFile(join(root, ".tfsb", "brand-exports.toml"), BRAND_EXPORTS);

    const brandFilesBefore = new Map<string, Buffer>();
    for (const entry of BRAND_FILE_INVENTORY) {
      brandFilesBefore.set(entry.canonicalPath, await readFile(join(root, entry.canonicalPath)));
    }

    // Modify source SVG to trigger directory reconciliation
    await writeFile(join(source, "icons", "alpha.svg"), sourceSvg("M0 0L2 2"));

    const result = await reconcileDirectoryProject({
      directory: source,
      root,
      sourceMap: join(source, ".tfsb-source-map.toml"),
      collections: ["icons"],
      resolutions: ["alpha=source"],
      apply: true,
    });
    expect(result.applied).toBe(true);

    await assertBrandFilesPreserved(root, brandFilesBefore);
  });

  it("no-op format and unchanged state plans preserve exact state and brand files", async () => {
    const { root, brandFilesBefore } = await createBrandedFixture();
    const fmtPlan = await planFormat(root);
    await executeFormat(fmtPlan);
    await assertBrandFilesPreserved(root, brandFilesBefore);

    const loadedBefore = await loadCanonicalProject(root, "check");
    const snapshotBefore = loadedBefore.snapshot;
    const loadedAfter = await loadCanonicalProject(root, "check");
    expect(loadedAfter.snapshot.files.size).toBe(snapshotBefore.files.size);
    await assertBrandFilesPreserved(root, brandFilesBefore);
  });

  it("aborts safely on mid-plan mutation races (delete, symlink, modified content) with zero residue", async () => {
    // 1. Brand file modified during plan
    {
      const { root } = await createBrandedFixture();
      const plan = await planAssetEdit({
        root,
        assetId: "beta",
        proposedToml: BETA.replace('title = "Beta"', 'title = "Updated Beta"'),
      });
      await writeFile(join(root, ".tfsb", "brand.toml"), BRAND_TOML + "# drift\n");
      await expect(executeAssetEdit(plan)).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "CANONICAL_CHANGED_DURING_PLAN");
      const entries = await readdir(join(root, ".tfsb"));
      expect(entries.some((e) => e.startsWith(".stage") || e.endsWith(".tmp") || e.endsWith(".lock"))).toBe(false);
    }

    // 2. Brand file deleted during plan
    {
      const { root } = await createBrandedFixture();
      const plan = await planAssetEdit({
        root,
        assetId: "beta",
        proposedToml: BETA.replace('title = "Beta"', 'title = "Updated Beta"'),
      });
      await rm(join(root, ".tfsb", "brand.toml"));
      await expect(executeAssetEdit(plan)).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "CANONICAL_CHANGED_DURING_PLAN");
      const entries = await readdir(join(root, ".tfsb"));
      expect(entries.some((e) => e.startsWith(".stage") || e.endsWith(".tmp") || e.endsWith(".lock"))).toBe(false);
    }

    // 3. Brand file replaced with symlink during plan
    {
      const { root } = await createBrandedFixture();
      const plan = await planAssetEdit({
        root,
        assetId: "beta",
        proposedToml: BETA.replace('title = "Beta"', 'title = "Updated Beta"'),
      });
      await rm(join(root, ".tfsb", "brand.toml"));
      const outside = join(root, "outside.toml");
      await writeFile(outside, BRAND_TOML);
      await symlink(outside, join(root, ".tfsb", "brand.toml"));
      await expect(executeAssetEdit(plan)).rejects.toSatisfy(
        (e: any) => e?.diagnostic?.code === "CANONICAL_CHANGED_DURING_PLAN" || e?.diagnostic?.code === "PROJECT_UNSUPPORTED_SOURCE",
      );
      const entries = await readdir(join(root, ".tfsb"));
      expect(entries.some((e) => e.startsWith(".stage") || e.endsWith(".tmp") || e.endsWith(".lock"))).toBe(false);
    }
  });

  it("rejects actual symlinks, oversized files, or arbitrary files in .tfsb at snapshot", async () => {
    const { root } = await createBrandedFixture();

    // 1. Symlinked brand.toml
    const outsideBrand = join(root, "outside-brand.toml");
    await writeFile(outsideBrand, BRAND_TOML);
    await rm(join(root, ".tfsb", "brand.toml"));
    await symlink(outsideBrand, join(root, ".tfsb", "brand.toml"));
    await expect(loadCanonicalProject(root, "check")).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "PROJECT_UNSUPPORTED_SOURCE");
    await rm(join(root, ".tfsb", "brand.toml"));
    await writeFile(join(root, ".tfsb", "brand.toml"), BRAND_TOML); // restore

    // 2. Symlinked brand-tokens.toml
    const outsideTokens = join(root, "outside-tokens.toml");
    await writeFile(outsideTokens, BRAND_TOKENS);
    await rm(join(root, ".tfsb", "brand-tokens.toml"));
    await symlink(outsideTokens, join(root, ".tfsb", "brand-tokens.toml"));
    await expect(loadCanonicalProject(root, "check")).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "PROJECT_UNSUPPORTED_SOURCE");
    await rm(join(root, ".tfsb", "brand-tokens.toml"));
    await writeFile(join(root, ".tfsb", "brand-tokens.toml"), BRAND_TOKENS); // restore

    // 3. Oversized brand.toml (> 1 MiB)
    const bigFile = join(root, ".tfsb", "brand.toml");
    const bigBuffer = Buffer.alloc(1048576 + 10, "a");
    await writeFile(bigFile, bigBuffer);
    await expect(loadCanonicalProject(root, "check")).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "PROJECT_UNSUPPORTED_SOURCE");

    // 4. Arbitrary .tfsb/extra.toml
    await writeFile(bigFile, BRAND_TOML); // restore
    await writeFile(join(root, ".tfsb", "extra.toml"), "foo = true\n");
    await expect(loadCanonicalProject(root, "check")).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "PROJECT_UNSUPPORTED_SOURCE");
    await rm(join(root, ".tfsb", "extra.toml"));

    // 5. Reserved future namespaces or invalid derived files
    await mkdir(join(root, ".tfsb", "derived"), { recursive: true });
    await writeFile(join(root, ".tfsb", "derived", "invalid.txt"), "not a receipt\n");
    await expect(loadCanonicalProject(root, "check")).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "PROJECT_UNSUPPORTED_SOURCE");
    await rm(join(root, ".tfsb", "derived"), { recursive: true });

    await mkdir(join(root, ".tfsb", "brand-baselines"), { recursive: true });
    await writeFile(join(root, ".tfsb", "brand-baselines", "invalid.txt"), "not supported\n");
    await expect(loadCanonicalProject(root, "check")).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "PROJECT_UNSUPPORTED_SOURCE");
    await rm(join(root, ".tfsb", "brand-baselines"), { recursive: true });
  });

  it("rejects oversized fixed brand file in proposed transaction tree", async () => {
    const { root } = await createBrandedFixture();
    const snapshot = await snapshotCanonicalTree(root, false, "fmt");
    const oversizedTree = new Map<string, Uint8Array>([
      [".tfsb/project.toml", Buffer.from(PROJECT)],
      [".tfsb/brand.toml", Buffer.alloc(1048576 + 1, 0x20)],
    ]);

    await expect(
      executeCanonicalTransaction({
        root,
        nextFiles: oversizedTree,
        expectedSnapshot: snapshot,
        operation: "fmt",
      }),
    ).rejects.toSatisfy((e: any) => e?.diagnostic?.code === "RESOURCE_LIMIT_EXCEEDED");
  });

  it("generic bundle produces identical archive entries with zero brand files leaked", async () => {
    const { root } = await createBrandedFixture();

    const result = await bundleProject({ root, output: "bundle.zip" });
    expect(result.written).toBe(true);

    const { unzipSync: decompress } = await import("fflate");
    const unzipped = decompress(await readFile(join(root, "bundle.zip")));
    // Generic bundle entries should only be assets, companions, and tfsb-manifest.json
    for (const name of Object.keys(unzipped)) {
      expect(name.startsWith("brand/")).toBe(false);
      expect(name.includes("brand")).toBe(false);
    }
  });

  it("preserves brand QA baseline files byte-for-byte across format, asset edit, migration, archive reconcile", async () => {
    const { root } = await createBrandedFixture();
    const loaded = await loadCanonicalProject(root, "check");
    const alphaAsset = loaded.assets.find((a) => a.id === "alpha")!;
    const alphaSvg = loaded.outputs.get(alphaAsset.filename)!;
    const { computeAssetSemanticDigest, computeSvgOutputDigest, computeSha256 } = await import("../../src/index.js");
    const assetDigest = computeAssetSemanticDigest(alphaAsset);
    const svgDigest = computeSvgOutputDigest(Buffer.from(alphaSvg).toString("utf8"));
    const baselinePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1]);
    const baselineDigest = computeSha256(baselinePng);

    const baselineQa = `schema = "tfsb.brand-qa"
schema_version = 1
[[profiles]]
id = "preservation"
renderer = "required"
formats = ["json"]
cases = ["golden"]
[[cases]]
id = "golden"
kind = "baseline"
asset = "alpha"
sizes = [[10, 10]]
backgrounds = ["transparent"]
baseline_path = ".tfsb/brand-baselines/preservation/golden.png"
baseline_digest = "${baselineDigest}"
renderer_id = "fake"
renderer_version = "1"
platform_claim = "portable"
canonical_asset_digest = "${assetDigest}"
svg_digest = "${svgDigest}"
`;
    await writeFile(join(root, ".tfsb", "brand-qa.toml"), baselineQa);
    await mkdir(join(root, ".tfsb", "brand-baselines", "preservation"), { recursive: true });
    await writeFile(join(root, ".tfsb", "brand-baselines", "preservation", "golden.png"), baselinePng);

    // 1. Format
    const fmtPlan = await planFormat(root);
    await executeFormat(fmtPlan);
    expect(await readFile(join(root, ".tfsb", "brand-baselines", "preservation", "golden.png"))).toEqual(baselinePng);

    // 2. Asset edit
    const editPlan = await planAssetEdit({
      root,
      assetId: "beta",
      proposedToml: BETA.replace('title = "Beta"', 'title = "Preserved Beta"'),
    });
    await executeAssetEdit(editPlan);
    expect(await readFile(join(root, ".tfsb", "brand-baselines", "preservation", "golden.png"))).toEqual(baselinePng);

    // 3. Migration
    const migPlan = await planMigration({ root });
    await executeMigration(migPlan);
    expect(await readFile(join(root, ".tfsb", "brand-baselines", "preservation", "golden.png"))).toEqual(baselinePng);

    // 4. Archive reconcile
    const archivePath = join(root, "input2.zip");
    const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-labelledby="alpha-title alpha-desc"><title id="alpha-title">Alpha</title><desc id="alpha-desc">Alpha icon</desc><path d="M0 0 L10 10"/></svg>';
    const zipBytes = zipSync({
      "alpha.svg": [Buffer.from(validSvg), {}],
    });
    await writeFile(archivePath, zipBytes);
    await reconcileProject({
      root,
      archive: archivePath,
      apply: true,
    });
    expect(await readFile(join(root, ".tfsb", "brand-baselines", "preservation", "golden.png"))).toEqual(baselinePng);
  });
});
