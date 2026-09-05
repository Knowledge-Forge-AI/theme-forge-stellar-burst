import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";

import {
  BRAND_BUNDLE_MANIFEST_FILENAME,
  BUNDLE_MANIFEST_FILENAME,
  bundleBrandProject,
  checkProject,
  computeAssetSemanticDigest,
  computeSha256,
  deriveBrandProject,
  importBrandProject,
  listProject,
  loadCanonicalProject,
  parseBrandBundleManifest,
} from "../../src/index.js";
import { runCli } from "../../src/cli.js";
import { readRepoFile, unwrap } from "../helpers.js";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function setupProjectWithDerived(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-bundle-import-"));
  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });

  const projectToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/project.toml");
  const assetLight = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml");

  await writeFile(join(root, ".tfsb", "project.toml"), projectToml);
  await writeFile(join(root, ".tfsb", "assets", "fixture-mark-on-light.toml"), assetLight);

  const brandToml = `schema = "tfsb.brand"
schema_version = 1
enabled_domains = { tokens = true, recipes = true, qa = false, consumer_profiles = false, package = true, exports = false }

[[families]]
id = "fixture-fam"
name = "Fixture Family"
required_roles = []
optional_roles = ["mark"]

[[variants]]
family = "fixture-fam"
id = "light"
backgrounds = ["light"]
color_mode = "full-color"
scale = "standard"
status = "primary"

[[variants]]
family = "fixture-fam"
id = "derived-dark"
backgrounds = ["dark"]
color_mode = "reversed"
scale = "standard"
status = "primary"

[[bindings]]
family = "fixture-fam"
role = "mark"
variant = "light"
asset = "fixture-mark-on-light"
authority = "source"

[[bindings]]
family = "fixture-fam"
role = "mark"
variant = "derived-dark"
asset = "fixture-mark-derived-dark"
authority = "derived"
`;

  const tokensToml = `schema = "tfsb.brand-tokens"
schema_version = 1

[[colors]]
id = "brand-blue"
value = "#0066CCFF"
`;

  const recipesToml = `schema = "tfsb.brand-recipes"
schema_version = 1

[[recipes]]
id = "recipe-derived-dark"
target_asset = "fixture-mark-derived-dark"
source_asset = "fixture-mark-on-light"

[[recipes.operations]]
operation = "replace-paint"
channel = "fill"
source_color = "#000000FF"
replacement_token = "brand-blue"
expected_occurrences = 1

[[recipes.operations]]
operation = "copy-accessibility"
policy = "preserve"
`;

  // Start with package = false so derive succeeds before package metadata exists
  await writeFile(join(root, ".tfsb", "brand.toml"), brandToml.replace("package = true", "package = false"));
  await writeFile(join(root, ".tfsb", "brand-tokens.toml"), tokensToml);
  await writeFile(join(root, ".tfsb", "brand-recipes.toml"), recipesToml);

  // Derive target assets
  await deriveBrandProject({ root, all: true });

  // Build project so outputs are present
  await runCli(["build"], root, capture().io);

  // Enable package = true and write placeholder brand-package.toml to compute system digest
  await writeFile(join(root, ".tfsb", "brand.toml"), brandToml);
  const placeholderPkgToml = `schema = "tfsb.brand-package"
schema_version = 1
package_id = "fixture-brand-pkg"
name = "Fixture Brand Package"
brand_version = "1.0.0"
families = ["fixture-fam"]
compatible_profiles = []
brand_system_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

[[inventory]]
family = "fixture-fam"
role = "mark"
variant = "light"
asset = "fixture-mark-on-light"
canonical_asset_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
svg_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
`;
  await writeFile(join(root, ".tfsb", "brand-package.toml"), placeholderPkgToml);

  // Compute brandSystemDigest and asset digests with package=true
  const loaded = await loadCanonicalProject(root, "check");
  const check = await checkProject(root);
  const sysDigest = check.brand?.brandSystemDigest;

  const lightAsset = loaded.assets.find((a) => a.id === "fixture-mark-on-light")!;
  const darkAsset = loaded.assets.find((a) => a.id === "fixture-mark-derived-dark")!;
  const lightSvgBytes = loaded.outputs.get("fixture-mark-on-light.svg")!;
  const darkSvgBytes = loaded.outputs.get("fixture-mark-derived-dark.svg")!;

  const pkgToml = `schema = "tfsb.brand-package"
schema_version = 1
package_id = "fixture-brand-pkg"
name = "Fixture Brand Package"
brand_version = "1.0.0"
families = ["fixture-fam"]
compatible_profiles = []
brand_system_digest = "${sysDigest}"

[[inventory]]
family = "fixture-fam"
role = "mark"
variant = "light"
asset = "fixture-mark-on-light"
canonical_asset_digest = "${computeAssetSemanticDigest(lightAsset)}"
svg_digest = "${computeSha256(lightSvgBytes)}"

[[inventory]]
family = "fixture-fam"
role = "mark"
variant = "derived-dark"
asset = "fixture-mark-derived-dark"
canonical_asset_digest = "${computeAssetSemanticDigest(darkAsset)}"
svg_digest = "${computeSha256(darkSvgBytes)}"
`;
  await writeFile(join(root, ".tfsb", "brand-package.toml"), pkgToml);

  return root;
}

describe("Brand Derived Bundle & Import", () => {
  it("bundles tokens, recipes, and derived assets, then imports into a clean destination", async () => {
    const srcRoot = await setupProjectWithDerived();
    const outputPath = "bundle.zip";

    // 1. Bundle
    const bundleRes = await bundleBrandProject({
      root: srcRoot,
      output: outputPath,
    });
    expect(bundleRes.written).toBe(true);
    expect(bundleRes.brandSystemDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 2. Inspect bundle
    const zipBytes = await readFile(join(srcRoot, outputPath));
    const unzipped = unzipSync(zipBytes);
    const manifestBytes = unzipped[BRAND_BUNDLE_MANIFEST_FILENAME];
    expect(manifestBytes).toBeDefined();
    const manifest = unwrap(parseBrandBundleManifest(new TextDecoder().decode(manifestBytes)));
    expect(manifest.domainDigests.brand).toBeDefined();
    expect(manifest.domainDigests.tokens).toBeDefined();
    expect(manifest.domainDigests.recipes).toBeDefined();
    expect(unzipped["derived/fixture-mark-derived-dark.receipt.json"]).toBeDefined();
    expect(manifest.derivedReceipts).toEqual([expect.objectContaining({
      targetId: "fixture-mark-derived-dark",
      recipeId: "recipe-derived-dark",
      bundlePath: "derived/fixture-mark-derived-dark.receipt.json",
    })]);
    const genericManifest = JSON.parse(new TextDecoder().decode(unzipped[BUNDLE_MANIFEST_FILENAME]!));
    expect(genericManifest.files).toContainEqual(expect.objectContaining({
      type: "file",
      path: "derived/fixture-mark-derived-dark.receipt.json",
    }));

    // 3. Import bundle into new clean directory
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-imported-"));
    const importPlan = await importBrandProject({
      archive: join(srcRoot, outputPath),
      root: targetRoot,
    });
    expect(importPlan.assets).toHaveLength(2);
    expect(importPlan.packageModel.packageId).toBe("fixture-brand-pkg");

    // 4. Verify imported project is clean, valid, and has derived state
    const checkRes = await checkProject(targetRoot);
    expect(checkRes.valid).toBe(true);
    expect(checkRes.brand).toBeDefined();
    expect(checkRes.brand?.brandSystemDigest).toBe(bundleRes.brandSystemDigest);
    expect(checkRes.brand?.derived?.total).toBe(1);
    expect(checkRes.brand?.derived?.humanOwned).toBe(0);
    expect(checkRes.brand?.derived?.unchanged).toBe(1);

    // 5. Verify list on imported project
    const listRes = await listProject(targetRoot);
    expect(listRes.assets).toHaveLength(2);
    const derived = listRes.assets.find((a) => a.id === "fixture-mark-derived-dark");
    expect(derived?.authority).toBe("derived");
    expect(derived?.derivedState).toBe("unchanged");
    expect(derived?.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 6. Imported lifecycle consumers all accept the restored receipt authority.
    expect(await runCli(["build"], targetRoot, capture().io)).toBe(0);
    expect(await runCli(["install"], targetRoot, capture().io)).toBe(0);
    const rebundle = await bundleBrandProject({ root: targetRoot, output: "rebundle.zip" });
    expect(rebundle.written).toBe(true);
    expect(await readFile(join(targetRoot, ".tfsb", "derived", "fixture-mark-derived-dark.receipt.json"))).toEqual(
      Buffer.from(unzipped["derived/fixture-mark-derived-dark.receipt.json"]!),
    );
    expect(await readFile(join(targetRoot, "rebundle.zip"))).toEqual(zipBytes);

    await rm(srcRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  it.each(["missing", "tampered", "extra"])("refuses to bundle %s derived receipt authority", async (fault) => {
    const root = await setupProjectWithDerived();
    const receiptPath = join(root, ".tfsb", "derived", "fixture-mark-derived-dark.receipt.json");
    if (fault === "missing") await rm(receiptPath);
    else if (fault === "tampered") await writeFile(receiptPath, "{}\n");
    else await writeFile(join(root, ".tfsb", "derived", "orphan.receipt.json"), await readFile(receiptPath));
    await expect(bundleBrandProject({ root, output: "fault.zip" })).rejects.toBeDefined();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a bundle whose derived receipt bytes are tampered", async () => {
    const root = await setupProjectWithDerived();
    await bundleBrandProject({ root, output: "bundle.zip" });
    const entries = unzipSync(await readFile(join(root, "bundle.zip")));
    entries["derived/fixture-mark-derived-dark.receipt.json"] = Buffer.from("{}\n");
    const tamperedPath = join(root, "tampered.zip");
    await writeFile(tamperedPath, zipSync(entries));
    const target = await mkdtemp(join(tmpdir(), "tfsb-import-tampered-"));
    await expect(importBrandProject({ archive: tamperedPath, root: target })).rejects.toBeDefined();
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });
});
