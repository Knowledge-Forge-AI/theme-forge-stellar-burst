import { describe, expect, it } from "vitest";

import {
  BRAND_BACKGROUNDS,
  BRAND_COLOR_MODES,
  BRAND_MAX_BINDINGS,
  BRAND_MAX_BINDINGS_PER_ASSET,
  BRAND_MAX_DIMENSION_PX,
  BRAND_MAX_DISPLAY_ORDER,
  BRAND_MAX_FAMILIES,
  BRAND_MAX_HUMAN_NAME_BYTES,
  BRAND_MAX_REFERENCED_ASSETS,
  BRAND_MAX_REQUIREMENTS,
  BRAND_MAX_ROLES,
  BRAND_MAX_VARIANTS,
  BRAND_MIN_DIMENSION_PX,
  BRAND_MIN_DISPLAY_ORDER,
  BRAND_SCALES,
  BRAND_TOML_MAX_BYTES,
  BRAND_VARIANT_STATUSES,
  computeBrandDigest,
  isValidBrandRole,
  parseBrandToml,
  serializeBrandToml,
} from "../../src/index.js";
import { firstCode, readRepoFile, unwrap } from "../helpers.js";

describe("brand schema 1 parser & serializer", () => {
  it("canonically parses and serializes core-minimal example", () => {
    const raw = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    const parsed = unwrap(parseBrandToml(raw));
    const serialized = serializeBrandToml(parsed);
    const reparsed = unwrap(parseBrandToml(serialized));
    expect(serializeBrandToml(reparsed)).toBe(serialized);
    expect(computeBrandDigest(parsed)).toBe(computeBrandDigest(reparsed));
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.endsWith("\n\n")).toBe(false);
  });

  it("canonically parses and serializes producer example", () => {
    const raw = readRepoFile("docs/examples/v0.4/brand-system/producer/.tfsb/brand.toml");
    const parsed = unwrap(parseBrandToml(raw));
    const serialized = serializeBrandToml(parsed);
    const reparsed = unwrap(parseBrandToml(serialized));
    expect(serializeBrandToml(reparsed)).toBe(serialized);
    expect(computeBrandDigest(parsed)).toBe(computeBrandDigest(reparsed));
  });

  it("formatting, whitespace, and comment variations produce identical semantic digests", () => {
    const raw = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    const formatted = `# Brand definition
schema = "tfsb.brand"
schema_version = 1

# Enabled domains
enabled_domains = { tokens = false, recipes = false, qa = false, consumer_profiles = false, package = true, exports = false }

[[families]]
name = "Core Fixture Brand"
id = "core-fixture"
optional_roles = []
required_roles = []

[[variants]]
family = "core-fixture"
id = "standard-dark"
status = "primary"
color_mode = "reversed"
scale = "standard"
backgrounds = ["dark"]
display_order = 1

[[variants]]
family = "core-fixture"
id = "standard-light"
status = "primary"
color_mode = "full-color"
scale = "standard"
backgrounds = ["light"]
display_order = 0

[[requirements]]
family = "core-fixture"
role = "mark"
background = "light"

[[requirements]]
family = "core-fixture"
role = "mark"
background = "dark"

[[bindings]]
family = "core-fixture"
role = "mark"
variant = "standard-dark"
asset = "fixture-mark-on-dark"
authority = "source"

[[bindings]]
family = "core-fixture"
role = "mark"
variant = "standard-light"
asset = "fixture-mark-on-light"
authority = "source"
`;
    const parsedRaw = unwrap(parseBrandToml(raw));
    const parsedFormatted = unwrap(parseBrandToml(formatted));
    expect(computeBrandDigest(parsedRaw)).toBe(computeBrandDigest(parsedFormatted));
  });

  it("rejects UTF-8 BOM", () => {
    const raw = "\uFEFFschema = \"tfsb.brand\"\nschema_version = 1\nenabled_domains = { tokens = false, recipes = false, qa = false, consumer_profiles = false, package = false, exports = false }\n[[families]]\nid = \"core\"\nname = \"Core\"\nrequired_roles = []\noptional_roles = []\n[[variants]]\nfamily = \"core\"\nid = \"std\"\nbackgrounds = [\"any\"]\ncolor_mode = \"full-color\"\nscale = \"standard\"\nstatus = \"primary\"\n[[bindings]]\nfamily = \"core\"\nrole = \"mark\"\nvariant = \"std\"\nasset = \"mark-asset\"\nauthority = \"source\"\n";
    expect(firstCode(parseBrandToml(raw))).toBe("SCHEMA_INVALID_BOM");
  });

  it("rejects stale v0.4 producer syntax and unknown keys", () => {
    const base = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    expect(firstCode(parseBrandToml("system_id = \"test\"\n" + base))).toBe("SCHEMA_UNKNOWN_KEY");
    expect(firstCode(parseBrandToml("name = \"Test\"\n" + base))).toBe("SCHEMA_UNKNOWN_KEY");
    expect(firstCode(parseBrandToml(base + "\n[domains]\ntokens = true\n"))).toBe("SCHEMA_UNKNOWN_KEY");
    expect(firstCode(parseBrandToml(base.replace("enabled_domains = {", "enabled_domains = { extra = true,")))).toBe("SCHEMA_UNKNOWN_KEY");
    expect(firstCode(parseBrandToml(base.replace("id = \"core-fixture\"", "id = \"core-fixture\"\nextra = 1")))).toBe("SCHEMA_UNKNOWN_KEY");
    expect(firstCode(parseBrandToml(base.replace("id = \"standard-light\"", "id = \"standard-light\"\nextra = 1")))).toBe("SCHEMA_UNKNOWN_KEY");
    expect(firstCode(parseBrandToml(base.replace("authority = \"source\"", "authority = \"source\"\nextra = 1")))).toBe("SCHEMA_UNKNOWN_KEY");
  });

  it("rejects invalid schema id and invalid schema version", () => {
    const base = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    expect(firstCode(parseBrandToml(base.replace("schema = \"tfsb.brand\"", "schema = \"other.brand\"")))).toBe("SCHEMA_INVALID_ID");
    expect(firstCode(parseBrandToml(base.replace("schema_version = 1", "schema_version = 2")))).toBe("SCHEMA_INVALID_VERSION");
    expect(firstCode(parseBrandToml(base.replace("schema_version = 1", "schema_version = 1.5")))).toBe("SCHEMA_INVALID_TYPE");
    expect(firstCode(parseBrandToml(base.replace("schema_version = 1", "schema_version = \"1\"")))).toBe("SCHEMA_INVALID_TYPE");
  });

  it("rejects duplicate TOML keys", () => {
    const base = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    expect(firstCode(parseBrandToml("schema = \"tfsb.brand\"\n" + base))).toBe("SCHEMA_DUPLICATE_KEY");
  });

  it("validates role grammar including extensions up to 129 bytes", () => {
    expect(isValidBrandRole("mark")).toBe(true);
    expect(isValidBrandRole("wordmark")).toBe(true);
    expect(isValidBrandRole("lockup-horizontal")).toBe(true);
    expect(isValidBrandRole("x.stellar.custom-mark")).toBe(true);
    expect(isValidBrandRole("x.stellar.deep-nested-mark")).toBe(true);
    expect(isValidBrandRole("x.stellar")).toBe(false); // missing second segment
    expect(isValidBrandRole("x.STELLAR.mark")).toBe(false); // uppercase
    expect(isValidBrandRole("invalid_role")).toBe(false); // underscore
    expect(isValidBrandRole("x." + "a".repeat(60) + "." + "b".repeat(65))).toBe(true); // 128 bytes
    expect(isValidBrandRole("x." + "a".repeat(60) + "." + "b".repeat(66))).toBe(true); // 129 bytes
    expect(isValidBrandRole("x." + "a".repeat(60) + "." + "b".repeat(67))).toBe(false); // 130 bytes
  });

  it("rejects role conflict between required and optional in family or requirements", () => {
    const base = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    const conflictInFamily = base.replace("required_roles = []", "required_roles = [\"mark\"]").replace("optional_roles = []", "optional_roles = [\"mark\"]");
    expect(firstCode(parseBrandToml(conflictInFamily))).toBe("BRAND_ROLE_CONFLICT");

    // Constrained requirement for a role declared optional in that family
    const conflictInReq = base.replace("optional_roles = []", "optional_roles = [\"mark\"]");
    expect(firstCode(parseBrandToml(conflictInReq))).toBe("BRAND_ROLE_CONFLICT");
  });

  it("rejects duplicate family, duplicate variant, and background 'any' conflict", () => {
    const base = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    const dupFam = base + "\n[[families]]\nid = \"core-fixture\"\nname = \"Duplicate\"\nrequired_roles = []\noptional_roles = []\n";
    expect(firstCode(parseBrandToml(dupFam))).toBe("BRAND_DUPLICATE_FAMILY");

    const dupVar = base + "\n[[variants]]\nfamily = \"core-fixture\"\nid = \"standard-light\"\nstatus = \"primary\"\ncolor_mode = \"full-color\"\nscale = \"standard\"\nbackgrounds = [\"light\"]\n";
    expect(firstCode(parseBrandToml(dupVar))).toBe("BRAND_DUPLICATE_VARIANT");

    const bgConflict = base.replace("backgrounds = [\"light\"]", "backgrounds = [\"any\", \"light\"]");
    expect(firstCode(parseBrandToml(bgConflict))).toBe("BRAND_BACKGROUND_CONFLICT");
  });

  it("rejects duplicate requirement predicates and duplicate bindings", () => {
    const base = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    const dupReq = base + "\n[[requirements]]\nfamily = \"core-fixture\"\nrole = \"mark\"\nbackground = \"light\"\n";
    expect(firstCode(parseBrandToml(dupReq))).toBe("BRAND_DUPLICATE_REQUIREMENT");

    const dupBinding = base + "\n[[bindings]]\nfamily = \"core-fixture\"\nrole = \"mark\"\nvariant = \"standard-light\"\nasset = \"fixture-mark-on-light\"\nauthority = \"source\"\n";
    expect(firstCode(parseBrandToml(dupBinding))).toBe("BRAND_DUPLICATE_BINDING");
  });

  it("enforces resource limits exact boundaries", () => {
    const makeName = (len: number) => {
      const base = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
      return base.replace("name = \"Core Fixture Brand\"", "name = \"" + "a".repeat(len) + "\"");
    };
    expect(parseBrandToml(makeName(BRAND_MAX_HUMAN_NAME_BYTES)).ok).toBe(true);
    expect(firstCode(parseBrandToml(makeName(BRAND_MAX_HUMAN_NAME_BYTES + 1)))).toBe("SCHEMA_INVALID_TEXT");

    const base = readRepoFile("docs/examples/v0.4/brand-system/core-minimal/.tfsb/brand.toml");
    expect(parseBrandToml(base.replace("display_order = 0", "display_order = " + BRAND_MIN_DISPLAY_ORDER)).ok).toBe(true);
    expect(parseBrandToml(base.replace("display_order = 0", "display_order = " + BRAND_MAX_DISPLAY_ORDER)).ok).toBe(true);
    expect(firstCode(parseBrandToml(base.replace("display_order = 0", "display_order = -1")))).toBe("SCHEMA_INVALID_RANGE");
    expect(firstCode(parseBrandToml(base.replace("display_order = 0", "display_order = " + (BRAND_MAX_DISPLAY_ORDER + 1))))).toBe("SCHEMA_INVALID_RANGE");

    expect(parseBrandToml(base.replace("scale = \"standard\"", "scale = \"standard\"\nminimum_width_px = " + BRAND_MIN_DIMENSION_PX + "\nminimum_height_px = " + BRAND_MAX_DIMENSION_PX)).ok).toBe(true);
    expect(firstCode(parseBrandToml(base.replace("scale = \"standard\"", "scale = \"standard\"\nminimum_width_px = " + (BRAND_MIN_DIMENSION_PX - 1))))).toBe("SCHEMA_INVALID_RANGE");
    expect(firstCode(parseBrandToml(base.replace("scale = \"standard\"", "scale = \"standard\"\nminimum_height_px = " + (BRAND_MAX_DIMENSION_PX + 1))))).toBe("SCHEMA_INVALID_RANGE");

    // 1 MiB brand.toml limit
    const padding = "# " + "x".repeat(100) + "\n";
    const head = "schema = \"tfsb.brand\"\nschema_version = 1\nenabled_domains = { tokens = false, recipes = false, qa = false, consumer_profiles = false, package = false, exports = false }\n[[families]]\nid = \"core\"\nname = \"Core\"\nrequired_roles = []\noptional_roles = [\"mark\"]\n[[variants]]\nfamily = \"core\"\nid = \"std\"\nbackgrounds = [\"any\"]\ncolor_mode = \"full-color\"\nscale = \"standard\"\nstatus = \"primary\"\n[[bindings]]\nfamily = \"core\"\nrole = \"mark\"\nvariant = \"std\"\nasset = \"asset-1\"\nauthority = \"source\"\n";
    const headLen = Buffer.byteLength(head, "utf8");
    const padCount = Math.floor((BRAND_TOML_MAX_BYTES - headLen) / 103);
    const validPadded = head + padding.repeat(padCount);
    expect(Buffer.byteLength(validPadded, "utf8")).toBeLessThanOrEqual(BRAND_TOML_MAX_BYTES);
    expect(parseBrandToml(validPadded).ok).toBe(true);
    const oversized = validPadded + "x".repeat(BRAND_TOML_MAX_BYTES - Buffer.byteLength(validPadded, "utf8") + 1);
    expect(Buffer.byteLength(oversized, "utf8")).toBe(BRAND_TOML_MAX_BYTES + 1);
    expect(firstCode(parseBrandToml(oversized))).toBe("RESOURCE_LIMIT_EXCEEDED");
  });

  it("enforces collections resource limits (families, variants, bindings, roles, requirements, referenced assets)", () => {
    const makeHeader = () => "schema = \"tfsb.brand\"\nschema_version = 1\nenabled_domains = { tokens = false, recipes = false, qa = false, consumer_profiles = false, package = false, exports = false }\n";

    // 1. Families limit (32 ok, 33 fails)
    let famToml = makeHeader();
    for (let i = 0; i < BRAND_MAX_FAMILIES; i++) {
      famToml += `[[families]]\nid = "fam-${i}"\nname = "Family ${i}"\nrequired_roles = []\noptional_roles = ["mark"]\n[[variants]]\nfamily = "fam-${i}"\nid = "std"\nbackgrounds = ["any"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "primary"\n[[bindings]]\nfamily = "fam-${i}"\nrole = "mark"\nvariant = "std"\nasset = "asset-${i}"\nauthority = "source"\n`;
    }
    expect(parseBrandToml(famToml).ok).toBe(true);
    const fam33Toml = famToml + `[[families]]\nid = "fam-extra"\nname = "Extra"\nrequired_roles = []\noptional_roles = ["mark"]\n[[variants]]\nfamily = "fam-extra"\nid = "std"\nbackgrounds = ["any"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "primary"\n[[bindings]]\nfamily = "fam-extra"\nrole = "mark"\nvariant = "std"\nasset = "asset-extra"\nauthority = "source"\n`;
    expect(firstCode(parseBrandToml(fam33Toml))).toBe("RESOURCE_LIMIT_EXCEEDED");

    // 2. Variants limit (256 ok, 257 fails)
    let varToml = makeHeader() + `[[families]]\nid = "fam-1"\nname = "Fam 1"\nrequired_roles = []\noptional_roles = ["mark"]\n`;
    for (let i = 0; i < BRAND_MAX_VARIANTS; i++) {
      varToml += `[[variants]]\nfamily = "fam-1"\nid = "var-${i}"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "${i === 0 ? "primary" : "secondary"}"\n`;
    }
    varToml += `[[bindings]]\nfamily = "fam-1"\nrole = "mark"\nvariant = "var-0"\nasset = "asset-1"\nauthority = "source"\n`;
    expect(parseBrandToml(varToml).ok).toBe(true);
    const var257Toml = varToml.replace(`[[bindings]]`, `[[variants]]\nfamily = "fam-1"\nid = "var-extra"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "secondary"\n[[bindings]]`);
    expect(firstCode(parseBrandToml(var257Toml))).toBe("RESOURCE_LIMIT_EXCEEDED");

    // 3. Bindings limit (1024 ok, 1025 fails) and bindings per asset (8 ok, 9 fails)
    let assetBindingsToml = makeHeader() + `[[families]]\nid = "fam-1"\nname = "Fam 1"\nrequired_roles = []\noptional_roles = []\n`;
    for (let i = 0; i < 9; i++) {
      assetBindingsToml += `[[variants]]\nfamily = "fam-1"\nid = "var-${i}"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "${i === 0 ? "primary" : "secondary"}"\n`;
    }
    // 8 bindings to asset-1 (with 8 distinct extension roles)
    let b8Toml = assetBindingsToml;
    for (let i = 0; i < BRAND_MAX_BINDINGS_PER_ASSET; i++) {
      b8Toml += `[[bindings]]\nfamily = "fam-1"\nrole = "x.tfsb.role-${i}"\nvariant = "var-${i}"\nasset = "asset-1"\nauthority = "source"\n`;
    }
    expect(parseBrandToml(b8Toml).ok).toBe(true);
    const b9Toml = b8Toml + `[[bindings]]\nfamily = "fam-1"\nrole = "x.tfsb.role-extra"\nvariant = "var-8"\nasset = "asset-1"\nauthority = "source"\n`;
    expect(firstCode(parseBrandToml(b9Toml))).toBe("RESOURCE_LIMIT_EXCEEDED");

    // 1024 total bindings: 256 variants x 4 roles = 1024 unique bindings across 128 assets (8 bindings per asset)
    const bRoles = ["mark", "wordmark", "app-icon", "favicon"];
    let b1024Toml = makeHeader() + `[[families]]\nid = "fam-1"\nname = "Fam 1"\nrequired_roles = []\noptional_roles = []\n`;
    for (let v = 0; v < BRAND_MAX_VARIANTS; v++) {
      b1024Toml += `[[variants]]\nfamily = "fam-1"\nid = "var-${v}"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "secondary"\n`;
    }
    let bIndex = 0;
    for (let v = 0; v < BRAND_MAX_VARIANTS; v++) {
      for (let r = 0; r < 4; r++) {
        const assetId = Math.floor(bIndex / BRAND_MAX_BINDINGS_PER_ASSET);
        b1024Toml += `[[bindings]]\nfamily = "fam-1"\nrole = "${bRoles[r]}"\nvariant = "var-${v}"\nasset = "asset-${assetId}"\nauthority = "source"\n`;
        bIndex++;
      }
    }
    expect(parseBrandToml(b1024Toml).ok).toBe(true);
    const b1025Toml = b1024Toml + `[[bindings]]\nfamily = "fam-1"\nrole = "avatar"\nvariant = "var-0"\nasset = "asset-0"\nauthority = "source"\n`;
    expect(firstCode(parseBrandToml(b1025Toml))).toBe("RESOURCE_LIMIT_EXCEEDED");

    // 4. Distinct roles limit (64 ok, 65 fails)
    let roles64Toml = makeHeader() + `[[families]]\nid = "fam-1"\nname = "Fam 1"\nrequired_roles = []\noptional_roles = []\n`;
    for (let i = 0; i < BRAND_MAX_ROLES; i++) {
      roles64Toml += `[[variants]]\nfamily = "fam-1"\nid = "var-${i}"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "secondary"\n`;
      roles64Toml += `[[bindings]]\nfamily = "fam-1"\nrole = "x.tfsb.role-${i}"\nvariant = "var-${i}"\nasset = "asset-${i}"\nauthority = "source"\n`;
    }
    expect(parseBrandToml(roles64Toml).ok).toBe(true);
    const roles65Toml = roles64Toml + `[[variants]]\nfamily = "fam-1"\nid = "var-64"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "secondary"\n[[bindings]]\nfamily = "fam-1"\nrole = "x.tfsb.role-64"\nvariant = "var-64"\nasset = "asset-64"\nauthority = "source"\n`;
    expect(firstCode(parseBrandToml(roles65Toml))).toBe("RESOURCE_LIMIT_EXCEEDED");

    // 5. Total required predicates limit (256 ok, 257 fails) across required_roles and requirements
    const reqRoles = ["mark", "wordmark", "app-icon", "favicon", "avatar", "social-card", "lockup-horizontal", "lockup-stacked"];
    let req256Toml = makeHeader();
    for (let f = 0; f < 32; f++) {
      req256Toml += `[[families]]\nid = "fam-${f}"\nname = "Fam ${f}"\nrequired_roles = []\noptional_roles = []\n[[variants]]\nfamily = "fam-${f}"\nid = "std"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "primary"\n[[bindings]]\nfamily = "fam-${f}"\nrole = "mark"\nvariant = "std"\nasset = "asset-${f}"\nauthority = "source"\n`;
    }
    for (let f = 0; f < 32; f++) {
      for (let r = 0; r < 8; r++) {
        req256Toml += `[[requirements]]\nfamily = "fam-${f}"\nrole = "${reqRoles[r]}"\nbackground = "light"\n`;
      }
    }
    expect(parseBrandToml(req256Toml).ok).toBe(true);
    const req257Toml = req256Toml + `[[requirements]]\nfamily = "fam-0"\nrole = "mark"\nbackground = "dark"\n`;
    expect(firstCode(parseBrandToml(req257Toml))).toBe("RESOURCE_LIMIT_EXCEEDED");

    // 6. Referenced assets limit (128 ok, 129 fails)
    let assets128Toml = makeHeader() + `[[families]]\nid = "fam-1"\nname = "Fam 1"\nrequired_roles = []\noptional_roles = []\n[[variants]]\nfamily = "fam-1"\nid = "std"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "primary"\n`;
    for (let i = 0; i < BRAND_MAX_REFERENCED_ASSETS; i++) {
      assets128Toml += `[[bindings]]\nfamily = "fam-1"\nrole = "mark"\nvariant = "std"\nasset = "asset-${i}"\nauthority = "source"\n`;
    }
    // Bindings with duplicate triple fails, so use distinct extension roles (up to 64) and variants
    let validAssets128Toml = makeHeader() + `[[families]]\nid = "fam-1"\nname = "Fam 1"\nrequired_roles = []\noptional_roles = []\n`;
    for (let v = 0; v < BRAND_MAX_REFERENCED_ASSETS; v++) {
      validAssets128Toml += `[[variants]]\nfamily = "fam-1"\nid = "var-${v}"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "secondary"\n`;
      validAssets128Toml += `[[bindings]]\nfamily = "fam-1"\nrole = "mark"\nvariant = "var-${v}"\nasset = "asset-${v}"\nauthority = "source"\n`;
    }
    expect(parseBrandToml(validAssets128Toml).ok).toBe(true);
    const assets129Toml = validAssets128Toml + `[[variants]]\nfamily = "fam-1"\nid = "var-128"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "secondary"\n[[bindings]]\nfamily = "fam-1"\nrole = "mark"\nvariant = "var-128"\nasset = "asset-128"\nauthority = "source"\n`;
    expect(firstCode(parseBrandToml(assets129Toml))).toBe("RESOURCE_LIMIT_EXCEEDED");
  });
});
