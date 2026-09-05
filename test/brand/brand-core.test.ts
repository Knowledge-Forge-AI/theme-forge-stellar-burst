import { describe, expect, it } from "vitest";

import {
  computeBrandDigest,
  computeBrandSystemDigest,
  computeSha256,
  encodeCanonicalJson,
  parseBrandToml,
  validateBrandSemantics,
} from "../../src/index.js";
import { discoverBrandState } from "../../src/brand/brand-availability.js";
import { loadBrandProject } from "../../src/brand/brand-core.js";
import { parseAssetTomlVersioned } from "../../src/schema-dispatch.js";
import { firstCode, readRepoFile, unwrap } from "../helpers.js";

function parseAsset(source: string, filename: string) {
  return unwrap(parseAssetTomlVersioned(source, 2, filename));
}

function expectDiagnosticCode(fn: () => unknown, expectedCode: string): void {
  try {
    fn();
    expect.unreachable("Expected function to throw DiagnosticError with code " + expectedCode);
  } catch (error: any) {
    expect(error?.diagnostic?.code).toBe(expectedCode);
  }
}

describe("brand core semantics & digests", () => {
  it("matches all canonical digest golden vectors", () => {
    const rawVectors = JSON.parse(readRepoFile("docs/examples/v0.4/brand-system/vectors/canonical-digest-vectors.json"));
    for (const vector of rawVectors.vectors) {
      if (typeof vector.preimage === "string" && typeof vector.sha256 === "string") {
        expect(computeSha256(Buffer.from(vector.preimage, "utf8")), vector.identifier).toBe(vector.sha256);
      }
      if (vector.category === "brand-toml") {
        const parsed = unwrap(parseBrandToml(vector.input));
        const digest = computeBrandDigest(parsed);
        expect(digest).toBe(vector.expectedDigest);
      } else if (vector.category === "brand-system") {
        const input = vector.input;
        const brandModel = unwrap(parseBrandToml(input.brandToml));
        const digest = computeBrandSystemDigest({
          brand: brandModel,
          tokens: null,
          recipes: null,
          qa: null,
          consumerProfiles: null,
          exports: null,
          referencedAssets: input.referencedAssets ?? [],
        });
        expect(digest).toBe(vector.expectedDigest);
      }
    }
  });

  it("validates referenced assets and rejects unknown asset references", () => {
    const raw = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    const model = unwrap(parseBrandToml(raw));

    const assetDark = parseAsset(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml"), ".tfsb/assets/fixture-mark-on-dark.toml");
    const assetLight = parseAsset(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml"), ".tfsb/assets/fixture-mark-on-light.toml");
    const validAssets = new Map([
      [assetDark.id, assetDark],
      [assetLight.id, assetLight],
    ]);

    const result = validateBrandSemantics(model, validAssets, { operation: "check", domain: "brand" });
    expect(result.completeness.satisfied).toBe(true);
    expect(result.referencedAssets.length).toBe(2);

    const missingAssets = new Map([
      [assetDark.id, assetDark],
    ]);

    expectDiagnosticCode(() => validateBrandSemantics(model, missingAssets, { operation: "check", domain: "brand" }), "BRAND_UNKNOWN_ASSET");
  });

  it("rejects undeclared roles in bindings", () => {
    const raw = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    const modified = raw.replace('role = "mark"\nvariant = "standard-light"', 'role = "favicon"\nvariant = "standard-light"');
    const model = unwrap(parseBrandToml(modified));
    const assetDark = parseAsset(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml"), ".tfsb/assets/fixture-mark-on-dark.toml");
    const assetLight = parseAsset(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml"), ".tfsb/assets/fixture-mark-on-light.toml");
    const validAssets = new Map([
      [assetDark.id, assetDark],
      [assetLight.id, assetLight],
    ]);

    expectDiagnosticCode(() => validateBrandSemantics(model, validAssets, { operation: "check", domain: "brand" }), "BRAND_UNDECLARED_ROLE");
  });

  it("detects primary binding ambiguity including any background overlaps", () => {
    const ambiguousToml = `schema = "tfsb.brand"
schema_version = 1
enabled_domains = { tokens = false, recipes = false, qa = false, consumer_profiles = false, package = false, exports = false }

[[families]]
id = "core"
name = "Core"
required_roles = []
optional_roles = ["mark"]

[[variants]]
family = "core"
id = "v-any"
backgrounds = ["any"]
color_mode = "full-color"
scale = "standard"
status = "primary"

[[variants]]
family = "core"
id = "v-light"
backgrounds = ["light"]
color_mode = "full-color"
scale = "standard"
status = "primary"

[[bindings]]
family = "core"
role = "mark"
variant = "v-any"
asset = "fixture-mark-on-light"
authority = "source"

[[bindings]]
family = "core"
role = "mark"
variant = "v-light"
asset = "fixture-mark-on-light"
authority = "source"
`;
    const model = unwrap(parseBrandToml(ambiguousToml));
    const assetLight = parseAsset(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml"), ".tfsb/assets/fixture-mark-on-light.toml");
    const assets = new Map([
      [assetLight.id, assetLight],
    ]);

    expectDiagnosticCode(() => validateBrandSemantics(model, assets, { operation: "check", domain: "brand" }), "BRAND_PRIMARY_AMBIGUITY");
  });

  it("validates unconstrained and constrained completeness semantics", () => {
    const assetLight = parseAsset(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml"), ".tfsb/assets/fixture-mark-on-light.toml");
    const assets = new Map([
      ["fixture-mark-on-light", assetLight],
    ]);

    // Unconstrained required role with 1 primary binding -> passes
    const validUnconstrained = `schema = "tfsb.brand"
schema_version = 1
enabled_domains = { tokens = false, recipes = false, qa = false, consumer_profiles = false, package = false, exports = false }
[[families]]
id = "core"
name = "Core"
required_roles = ["mark"]
optional_roles = []
[[variants]]
family = "core"
id = "std"
backgrounds = ["any"]
color_mode = "full-color"
scale = "standard"
status = "primary"
[[bindings]]
family = "core"
role = "mark"
variant = "std"
asset = "fixture-mark-on-light"
authority = "source"
`;
    const unconstrainedModel = unwrap(parseBrandToml(validUnconstrained));
    expect(validateBrandSemantics(unconstrainedModel, assets, { operation: "check", domain: "brand" }).completeness.satisfied).toBe(true);

    // Unconstrained required role with 0 bindings -> fails BRAND_REQUIREMENT_UNSATISFIED
    const missingBinding = validUnconstrained.replace("required_roles = [\"mark\"]", "required_roles = [\"mark\", \"wordmark\"]");
    const missingModel = unwrap(parseBrandToml(missingBinding));
    expectDiagnosticCode(() => validateBrandSemantics(missingModel, assets, { operation: "check", domain: "brand" }), "BRAND_REQUIREMENT_UNSATISFIED");

    // Constrained requirement with 0 matching bindings -> fails BRAND_REQUIREMENT_UNSATISFIED
    const specificVariant = `schema = "tfsb.brand"
schema_version = 1
enabled_domains = { tokens = false, recipes = false, qa = false, consumer_profiles = false, package = false, exports = false }
[[families]]
id = "core"
name = "Core"
required_roles = []
optional_roles = []
[[variants]]
family = "core"
id = "std"
backgrounds = ["light"]
color_mode = "full-color"
scale = "standard"
status = "primary"
[[requirements]]
family = "core"
role = "mark"
background = "dark"
[[bindings]]
family = "core"
role = "mark"
variant = "std"
asset = "fixture-mark-on-light"
authority = "source"
`;
    const specificModel = unwrap(parseBrandToml(specificVariant));
    expectDiagnosticCode(() => validateBrandSemantics(specificModel, assets, { operation: "check", domain: "brand" }), "BRAND_REQUIREMENT_UNSATISFIED");
  });

  it("fails closed on derived binding authority when recipes domain is disabled", () => {
    const raw = readRepoFile("docs/examples/v0.4/brand-system/producer/.tfsb/brand.toml").replace("recipes = true", "recipes = false");
    const model = unwrap(parseBrandToml(raw));
    const assetLight = parseAsset(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml"), ".tfsb/assets/fixture-mark-on-light.toml");
    const allAssets = new Map<string, any>();
    for (const b of model.bindings) {
      allAssets.set(b.asset, { ...assetLight, id: b.asset });
    }

    expectDiagnosticCode(() => validateBrandSemantics(model, allAssets, { operation: "check", domain: "brand" }), "BRAND_RECIPE_CAPABILITY_UNAVAILABLE");
  });

  it("handles domain discovery and presence validation", () => {
    const ctx = { operation: "check" as const, domain: "brand" as const };

    // Unbranded
    expect(discoverBrandState(new Map(), ctx).branded).toBe(false);

    // Companion present without brand.toml -> fails BRAND_MARKER_MISSING
    const companionOnly = new Map([
      [".tfsb/brand-tokens.toml", { bytes: Buffer.from("test") }],
    ]);
    expectDiagnosticCode(() => discoverBrandState(companionOnly, ctx), "BRAND_MARKER_MISSING");

    // Enabled domain with missing file -> fails BRAND_DOMAIN_FILE_MISSING
    const brandTomlPackageEnabled = Buffer.from(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml"));
    const missingPackageFile = new Map([
      [".tfsb/brand.toml", { bytes: brandTomlPackageEnabled }],
    ]);
    expectDiagnosticCode(() => discoverBrandState(missingPackageFile, ctx), "BRAND_DOMAIN_FILE_MISSING");

    // Disabled domain with file present -> fails BRAND_DOMAIN_FILE_PRESENT_WHEN_DISABLED
    const disabledPackageFile = new Map([
      [".tfsb/brand.toml", { bytes: Buffer.from(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml").replace("package = true", "package = false")) }],
      [".tfsb/brand-package.toml", { bytes: Buffer.from("test") }],
    ]);
    expectDiagnosticCode(() => discoverBrandState(disabledPackageFile, ctx), "BRAND_DOMAIN_FILE_PRESENT_WHEN_DISABLED");

    // Valid core-only B1 project computes system digest
    const coreOnlyBrandToml = Buffer.from(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml").replace("package = true", "package = false"));
    const coreOnlyFiles = new Map([
      [".tfsb/brand.toml", { bytes: coreOnlyBrandToml }],
    ]);
    const assetDark = parseAsset(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-dark.toml"), ".tfsb/assets/fixture-mark-on-dark.toml");
    const assetLight = parseAsset(readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/assets/fixture-mark-on-light.toml"), ".tfsb/assets/fixture-mark-on-light.toml");
    const validAssets = new Map([
      [assetDark.id, assetDark],
      [assetLight.id, assetLight],
    ]);
    const loaded = loadBrandProject(coreOnlyFiles, validAssets, ctx);
    expect(loaded).toBeDefined();
    expect(loaded?.brandSystemDigest).toBe("sha256:0d399a54375f952fc75a31e1ca59c99df4699dd3b665b99e30998470203a5980");

    // Invalid UTF-8 in brand.toml throws fatal error
    const invalidUtf8Files = new Map([
      [".tfsb/brand.toml", { bytes: Buffer.from([0xff, 0xfe, 0x80, 0x81]) }],
    ]);
    expectDiagnosticCode(() => discoverBrandState(invalidUtf8Files, ctx), "SCHEMA_INVALID_SYNTAX");
  });

  it("encodeCanonicalJson strictly rejects unsupported types, non-plain objects, sparse arrays, and non-safe integers", () => {
    expect(encodeCanonicalJson({ a: 1, b: "hello", c: true, d: false, e: null })).toBe('{"a":1,"b":"hello","c":true,"d":false,"e":null}');
    expect(() => encodeCanonicalJson(new Date())).toThrow("Canonical JSON only supports plain objects");
    expect(() => encodeCanonicalJson(new Map())).toThrow("Canonical JSON only supports plain objects");
    expect(() => encodeCanonicalJson(new Set())).toThrow("Canonical JSON only supports plain objects");
    expect(() => encodeCanonicalJson(class Foo {})).toThrow("Canonical JSON cannot encode type: function");
    expect(() => encodeCanonicalJson(1.5)).toThrow("Canonical JSON requires safe integers");
    expect(() => encodeCanonicalJson(NaN)).toThrow("Canonical JSON requires safe integers");
    expect(() => encodeCanonicalJson(Infinity)).toThrow("Canonical JSON requires safe integers");

    const sparseArr: any[] = [];
    sparseArr[2] = "value";
    expect(() => encodeCanonicalJson(sparseArr)).toThrow("Canonical JSON does not support sparse arrays");
    expect(() => encodeCanonicalJson([undefined])).toThrow("Canonical JSON does not support sparse arrays");
  });
});
