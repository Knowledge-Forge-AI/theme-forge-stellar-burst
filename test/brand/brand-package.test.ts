import { describe, expect, it } from "vitest";

import {
  BRAND_PACKAGE_COMPANION_PURPOSES,
  BRAND_PACKAGE_DIGEST_BASIS,
  BRAND_PACKAGE_MAX_BYTES,
  BRAND_PACKAGE_MAX_COMPANIONS,
  BRAND_PACKAGE_MAX_ENTRIES,
  BRAND_PACKAGE_MAX_FAMILIES,
  BRAND_PACKAGE_MAX_INVENTORY,
  BRAND_PACKAGE_MEDIA_TYPES,
  BRAND_PACKAGE_SCHEMA_ID,
  BRAND_PACKAGE_SCHEMA_VERSION,
  computeBrandPackageDigest,
  parseBrandPackageToml,
  serializeBrandPackageToml,
} from "../../src/index.js";
import { readRepoFile } from "../helpers.js";

describe("brand-package model, parser, digest, and serializer", () => {
  it("matches golden digest vector 6 for brand-package-toml-core-fixture", () => {
    const pkgToml = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand-package.toml");
    const parsed = parseBrandPackageToml(pkgToml, ".tfsb/brand-package.toml");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const model = parsed.value;
    expect(model.schema).toBe("tfsb.brand-package");
    expect(model.schemaVersion).toBe(1);
    expect(model.packageId).toBe("core-fixture-brand");
    expect(model.name).toBe("Core Fixture Brand Package");
    expect(model.brandVersion).toBe("0.4.0-fixture.1");
    expect(model.families).toEqual(["core-fixture"]);
    expect(model.compatibleProfiles).toEqual([]);
    expect(model.brandSystemDigest).toBe("sha256:4e10ef25161f37bdd137bcf85fcf1b842b4e0a6512f863d7f2fbba0d8a7e9c4d");

    expect(model.companions.length).toBe(1);
    expect(model.companions[0]!.id).toBe("fixture-guidance");
    expect(model.companions[0]!.source).toBe("GUIDANCE.md");
    expect(model.companions[0]!.bundlePath).toBe("companions/GUIDANCE.md");
    expect(model.companions[0]!.canonicalCompanionFile).toBe("GUIDANCE.md");
    expect(model.companions[0]!.mediaType).toBe("text/markdown");
    expect(model.companions[0]!.purpose).toBe("brand-guidance");
    expect(model.companions[0]!.required).toBe(true);
    expect(model.companions[0]!.digest).toBe("sha256:10a61401be21913c99086526840a27a24991815db9d7044ac1668787e737a9d3");

    expect(model.inventory.length).toBe(2);
    expect(model.inventory[0]!.family).toBe("core-fixture");
    expect(model.inventory[0]!.role).toBe("mark");
    expect(model.inventory[0]!.variant).toBe("standard-dark");
    expect(model.inventory[0]!.asset).toBe("fixture-mark-on-dark");
    expect(model.inventory[0]!.canonicalAssetDigest).toBe("sha256:6a95e550c0c3e92793a873251eed3bc888e5e4c4a3355124d5230eaebe479387");
    expect(model.inventory[0]!.svgDigest).toBe("sha256:1068a15abd03564d4a48257825914baa14ae26990aad96c0c8f46e2d5a27a15b");

    expect(model.inventory[1]!.family).toBe("core-fixture");
    expect(model.inventory[1]!.role).toBe("mark");
    expect(model.inventory[1]!.variant).toBe("standard-light");
    expect(model.inventory[1]!.asset).toBe("fixture-mark-on-light");
    expect(model.inventory[1]!.canonicalAssetDigest).toBe("sha256:8e53627c743ba21b079b281638804f3a9214895686514dbf5fec0c279db71667");
    expect(model.inventory[1]!.svgDigest).toBe("sha256:a1bf2b63584d6c5e7832d2e7c29f9137f6f15c4a0d004b9e71c1ee599d75d75f");

    const digest = computeBrandPackageDigest(model);
    expect(digest).toBe("sha256:1c14df2cf73b282f366a5cef541cea1f3d9d08c1ab55c1ebbbf34e2f63ab9f23");

    // Test serialization round-trip
    const serialized = serializeBrandPackageToml(model);
    const reparsed = parseBrandPackageToml(serialized);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(computeBrandPackageDigest(reparsed.value)).toBe(digest);
    }
  });

  it("supports optional fields: summary, usage, trademark, npm_package", () => {
    const toml = `
schema = "tfsb.brand-package"
schema_version = 1
package_id = "test-pkg"
name = "Test Package"
brand_version = "1.0.0"
summary = "A test package summary"
usage = "Test usage terms"
trademark = "Test trademark notice"
families = ["core"]
compatible_profiles = ["web", "mobile"]
brand_system_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

[npm_package]
name = "@org/brand-assets"
version = "1.0.0"

[[inventory]]
family = "core"
role = "mark"
variant = "light"
asset = "core-mark-light"
canonical_asset_digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
svg_digest = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
`;

    const parsed = parseBrandPackageToml(toml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.summary).toBe("A test package summary");
    expect(parsed.value.usage).toBe("Test usage terms");
    expect(parsed.value.trademark).toBe("Test trademark notice");
    expect(parsed.value.npmPackage?.name).toBe("@org/brand-assets");
    expect(parsed.value.npmPackage?.version).toBe("1.0.0");
    expect(parsed.value.compatibleProfiles).toEqual(["mobile", "web"]);

    const serialized = serializeBrandPackageToml(parsed.value);
    expect(serialized).toContain('summary = "A test package summary"');
    expect(serialized).toContain('usage = "Test usage terms"');
    expect(serialized).toContain('trademark = "Test trademark notice"');
    expect(serialized).toContain("[npm_package]");

    const reparsed = parseBrandPackageToml(serialized);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(computeBrandPackageDigest(reparsed.value)).toBe(computeBrandPackageDigest(parsed.value));
    }
  });

  it("validates strict SemVer format", () => {
    const makeToml = (version: string) => `
schema = "tfsb.brand-package"
schema_version = 1
package_id = "test-pkg"
name = "Test"
brand_version = "${version}"
families = ["core"]
compatible_profiles = []
brand_system_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

[[inventory]]
family = "core"
role = "mark"
variant = "light"
asset = "core-mark-light"
canonical_asset_digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
svg_digest = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
`;

    expect(parseBrandPackageToml(makeToml("1.0.0")).ok).toBe(true);
    expect(parseBrandPackageToml(makeToml("0.4.0-fixture.1")).ok).toBe(true);
    expect(parseBrandPackageToml(makeToml("2.1.3-beta.1+build.123")).ok).toBe(true);

    expect(parseBrandPackageToml(makeToml("1.0")).ok).toBe(false);
    expect(parseBrandPackageToml(makeToml("v1.0.0")).ok).toBe(false);
    expect(parseBrandPackageToml(makeToml("1.0.0.0")).ok).toBe(false);
    expect(parseBrandPackageToml(makeToml("latest")).ok).toBe(false);
  });

  it("enforces Option A companion restrictions", () => {
    const makeCompToml = (override: string) => `
schema = "tfsb.brand-package"
schema_version = 1
package_id = "test-pkg"
name = "Test"
brand_version = "1.0.0"
families = ["core"]
compatible_profiles = []
brand_system_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

[[companions]]
id = "fixture-guidance"
source = "GUIDANCE.md"
bundle_path = "companions/GUIDANCE.md"
canonical_companion_file = "GUIDANCE.md"
media_type = "text/markdown"
purpose = "brand-guidance"
digest = "sha256:10a61401be21913c99086526840a27a24991815db9d7044ac1668787e737a9d3"
required = true
${override}

[[inventory]]
family = "core"
role = "mark"
variant = "light"
asset = "core-mark-light"
canonical_asset_digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
svg_digest = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
`;

    // Invalid media_type (e.g. application/pdf)
    const badMedia = makeCompToml('').replace('media_type = "text/markdown"', 'media_type = "application/pdf"');
    const resMedia = parseBrandPackageToml(badMedia);
    expect(resMedia.ok).toBe(false);
    if (!resMedia.ok) expect(resMedia.diagnostics[0]!.code).toBe("SCHEMA_INVALID_ENUM");

    // Invalid purpose
    const badPurpose = makeCompToml('').replace('purpose = "brand-guidance"', 'purpose = "custom-purpose"');
    const resPurpose = parseBrandPackageToml(badPurpose);
    expect(resPurpose.ok).toBe(false);
    if (!resPurpose.ok) expect(resPurpose.diagnostics[0]!.code).toBe("SCHEMA_INVALID_ENUM");

    // Bundle path mismatch
    const badBundlePath = makeCompToml('').replace('bundle_path = "companions/GUIDANCE.md"', 'bundle_path = "other/GUIDANCE.md"');
    const resBundlePath = parseBrandPackageToml(badBundlePath);
    expect(resBundlePath.ok).toBe(false);
    if (!resBundlePath.ok) expect(resBundlePath.diagnostics[0]!.code).toBe("BRAND_PACKAGE_INVALID_BUNDLE_PATH");

    // Invalid canonical companion filename
    const badCompFile = makeCompToml('')
      .replace('canonical_companion_file = "GUIDANCE.md"', 'canonical_companion_file = "unsupported.exe"')
      .replace('bundle_path = "companions/GUIDANCE.md"', 'bundle_path = "companions/unsupported.exe"');
    const resCompFile = parseBrandPackageToml(badCompFile);
    expect(resCompFile.ok).toBe(false);
    if (!resCompFile.ok) expect(resCompFile.diagnostics[0]!.code).toBe("BRAND_PACKAGE_INVALID_COMPANION_FILE");
  });

  it("enforces schema boundaries and limits", () => {
    // 1. File size limit
    const hugeToml = " ".repeat(BRAND_PACKAGE_MAX_BYTES + 1);
    const resHuge = parseBrandPackageToml(hugeToml);
    expect(resHuge.ok).toBe(false);
    if (!resHuge.ok) expect(resHuge.diagnostics[0]!.code).toBe("RESOURCE_LIMIT_EXCEEDED");

    // 2. BOM rejection
    const bomToml = "\uFEFFschema = 'tfsb.brand-package'";
    const resBom = parseBrandPackageToml(bomToml);
    expect(resBom.ok).toBe(false);
    if (!resBom.ok) expect(resBom.diagnostics[0]!.code).toBe("SCHEMA_INVALID_BOM");

    // 3. Unknown keys rejection
    const unknownKeyToml = `
schema = "tfsb.brand-package"
schema_version = 1
package_id = "test-pkg"
name = "Test"
brand_version = "1.0.0"
unknown_field = "invalid"
families = ["core"]
compatible_profiles = []
brand_system_digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
[[inventory]]
family = "core"
role = "mark"
variant = "light"
asset = "core-mark-light"
canonical_asset_digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
svg_digest = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
`;
    const resUnknown = parseBrandPackageToml(unknownKeyToml);
    expect(resUnknown.ok).toBe(false);
    if (!resUnknown.ok) expect(resUnknown.diagnostics[0]!.code).toBe("SCHEMA_UNKNOWN_KEY");
  });
});
