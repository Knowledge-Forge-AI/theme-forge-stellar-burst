import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  BRAND_BUNDLE_MANIFEST_FILENAME,
  BUNDLE_MANIFEST_FILENAME,
  buildProject,
  bundleBrandProject,
  checkProject,
  importBrandProject,
} from "../../src/index.js";
import { computeAssetSemanticDigest, computeRawSha256 } from "../../src/digests.js";
import { validateBrandSemantics } from "../../src/brand/brand-core.js";
import { computeBrandSystemDigest } from "../../src/brand/brand-digests.js";
import { parseBrandToml } from "../../src/brand/brand-schema.js";
import { parseAssetTomlV2 } from "../../src/schema2-toml.js";
import { serializeSvgV2 } from "../../src/schema2-svg.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0, roots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("brand multi-binding and custom asset filenames", () => {
  it("bundles and roundtrip-imports a brand package where one asset fulfills multiple bindings and has a custom filename", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "tfsb-multi-src-"));
    roots.push(sourceRoot);

    await mkdir(join(sourceRoot, ".tfsb", "assets"), { recursive: true });

    // Project TOML
    const projectToml = `schema_version = 2
name = "multi-binding-test"

[build]
directory = "dist"
`;

    // Asset with custom filename != assetId
    // assetId: "mark-shared", filename: "my-custom-mark.svg"
    const assetToml = `schema_version = 2
id = "mark-shared"
filename = "my-custom-mark.svg"

[canvas]
view_box = "0 0 100 100"

[accessibility]
mode = "decorative"

[[elements]]
type = "circle"
cx = 50
cy = 50
r = 40
fill = "#123456"
`;

    // Brand schema with 2 bindings referencing the same asset
    const brandToml = `schema = "tfsb.brand"
schema_version = 1
enabled_domains = { tokens = false, recipes = false, qa = false, consumer_profiles = false, package = true, exports = false }

[[families]]
id = "core"
name = "Core"
required_roles = []
optional_roles = []

[[variants]]
family = "core"
id = "dark-standard"
backgrounds = ["dark"]
color_mode = "full-color"
scale = "standard"
status = "primary"
display_order = 0

[[variants]]
family = "core"
id = "dark-simplified"
backgrounds = ["dark"]
color_mode = "full-color"
scale = "simplified"
status = "primary"
display_order = 1

[[requirements]]
family = "core"
role = "mark"
background = "dark"
scale = "standard"

[[requirements]]
family = "core"
role = "mark"
background = "dark"
scale = "simplified"

[[bindings]]
family = "core"
role = "mark"
variant = "dark-standard"
asset = "mark-shared"
authority = "source"

[[bindings]]
family = "core"
role = "mark"
variant = "dark-simplified"
asset = "mark-shared"
authority = "source"
`;

    const parsedAssetRes = parseAssetTomlV2(assetToml);
    if (!parsedAssetRes.ok) throw new Error("Failed to parse asset");
    const parsedAsset = parsedAssetRes.value;

    const parsedBrandRes = parseBrandToml(brandToml);
    if (!parsedBrandRes.ok) throw new Error("Failed to parse brand");
    const parsedBrand = parsedBrandRes.value;

    const canonicalAssetDigest = computeAssetSemanticDigest(parsedAsset);
    const renderedSvgRes = serializeSvgV2(parsedAsset.svg, "my-custom-mark.svg");
    if (!renderedSvgRes.ok) throw new Error("Failed to render svg");
    const svgDigest = `sha256:${computeRawSha256(Buffer.from(renderedSvgRes.value, "utf8"))}`;

    const semantics = validateBrandSemantics(parsedBrand, new Map([["mark-shared", parsedAsset]]), {
      operation: "build",
      domain: "project",
    });

    const brandSysDigest = computeBrandSystemDigest({
      brand: parsedBrand,
      tokens: null,
      recipes: null,
      qa: null,
      consumerProfiles: null,
      exports: null,
      referencedAssets: semantics.referencedAssets,
    });

    const pkgToml = `schema = "tfsb.brand-package"
schema_version = 1
package_id = "multi-binding-brand"
name = "Multi Binding Brand"
brand_version = "1.0.0"
families = ["core"]
compatible_profiles = []
brand_system_digest = "${brandSysDigest}"

[[inventory]]
family = "core"
role = "mark"
variant = "dark-standard"
asset = "mark-shared"
canonical_asset_digest = "${canonicalAssetDigest}"
svg_digest = "${svgDigest}"

[[inventory]]
family = "core"
role = "mark"
variant = "dark-simplified"
asset = "mark-shared"
canonical_asset_digest = "${canonicalAssetDigest}"
svg_digest = "${svgDigest}"
`;

    await writeFile(join(sourceRoot, ".tfsb", "project.toml"), projectToml);
    await writeFile(join(sourceRoot, ".tfsb", "assets", "mark-shared.toml"), assetToml);
    await writeFile(join(sourceRoot, ".tfsb", "brand.toml"), brandToml);
    await writeFile(join(sourceRoot, ".tfsb", "brand-package.toml"), pkgToml);

    // Build project so visual assets are rendered
    await buildProject(sourceRoot);

    // Bundle
    const bundleZipPath = join(sourceRoot, "multi.zip");
    const bundleResult = await bundleBrandProject({
      root: sourceRoot,
      output: "multi.zip",
    });

    expect(bundleResult.written).toBe(true);
    expect(bundleResult.assetCount).toBe(2); // 2 inventory bindings

    // Verify ZIP entries & manifests
    const zipBytes = await readFile(bundleZipPath);
    const unzipped = unzipSync(zipBytes);

    // Must contain exactly 1 asset entry with custom filename
    expect(unzipped["assets/my-custom-mark.svg"]).toBeDefined();
    expect(unzipped["assets/mark-shared.svg"]).toBeUndefined();

    // Check generic manifest has exactly 1 asset file record
    const genericMani = JSON.parse(new TextDecoder().decode(unzipped[BUNDLE_MANIFEST_FILENAME]!));
    const assetFiles = genericMani.files.filter((f: any) => f.type === "asset");
    expect(assetFiles.length).toBe(1);
    expect(assetFiles[0].path).toBe("assets/my-custom-mark.svg");
    expect(assetFiles[0].assetId).toBe("mark-shared");

    // Check brand manifest has 2 inventory bindings
    const brandMani = JSON.parse(new TextDecoder().decode(unzipped[BRAND_BUNDLE_MANIFEST_FILENAME]!));
    expect(brandMani.inventory.length).toBe(2);
    expect(brandMani.inventory[0].bundlePath).toBe("assets/my-custom-mark.svg");
    expect(brandMani.inventory[1].bundlePath).toBe("assets/my-custom-mark.svg");

    // Now import into new target
    const targetRoot = await mkdtemp(join(tmpdir(), "tfsb-multi-target-"));
    roots.push(targetRoot);

    const importPlan = await importBrandProject({
      archive: bundleZipPath,
      root: targetRoot,
    });

    expect(importPlan.assets.length).toBe(1);
    expect(importPlan.assets[0]!.id).toBe("mark-shared");
    expect(importPlan.assets[0]!.filename).toBe("my-custom-mark.svg");

    // Verify imported canonical TOML preserves custom filename
    const importedAssetToml = await readFile(join(targetRoot, ".tfsb", "assets", "mark-shared.toml"), "utf8");
    expect(importedAssetToml).toContain('filename = "my-custom-mark.svg"');

    // Build and check target
    await buildProject(targetRoot);
    const checkResult = await checkProject(targetRoot);
    expect(checkResult.valid).toBe(true);
    expect(checkResult.drift).toBe(false);
  });
});
