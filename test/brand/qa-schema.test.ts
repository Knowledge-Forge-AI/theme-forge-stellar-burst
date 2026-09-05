import { describe, expect, it } from "vitest";

import { BRAND_QA_MAX_BYTES, BRAND_QA_MAX_DIMENSION, computeBrandQaDigest, encodeCanonicalJson, parseBrandQaToml, serializeBrandQaToml, toBrandQaCanonicalDto } from "../../src/index.js";
import { readRepoFile, unwrap } from "../helpers.js";

const BASE = `schema = "tfsb.brand-qa"
schema_version = 1

[[profiles]]
id = "release"
renderer = "optional"
formats = ["json", "markdown", "html"]
cases = ["inventory", "accessibility", "palette", "external", "embedded", "recipe", "canvas", "pixels", "transparent", "clip", "padding", "small"]

[[cases]]
id = "inventory"
kind = "inventory"
family = "core"

[[cases]]
id = "accessibility"
kind = "accessibility"
family = "core"
require_consistent_labels = true

[[cases]]
id = "palette"
kind = "palette"
asset = "mark"
allowed_tokens = ["black"]
allow_literals = false

[[cases]]
id = "external"
kind = "external-reference"
asset = "mark"
forbid_external_urls = true
forbid_external_images = true
forbid_external_uses = true
forbid_external_styles = true
forbid_external_fonts = true

[[cases]]
id = "embedded"
kind = "embedded-content"
asset = "mark"
forbid_embedded_raster = true
forbid_embedded_fonts = true

[[cases]]
id = "recipe"
kind = "recipe"
recipe = "make-mark"
verify_provenance = true
verify_receipts = true

[[cases]]
id = "canvas"
kind = "canvas"
asset = "mark"
require_viewbox = true
enforce_minimum_size = false

[[cases]]
id = "pixels"
kind = "pixel-bounds"
asset = "mark"
sizes = [[16, 16]]
backgrounds = ["transparent"]
alpha_threshold = 0

[[cases]]
id = "transparent"
kind = "transparent-bounds"
asset = "mark"
sizes = [[16, 16]]
backgrounds = ["#FFFFFFFF"]
alpha_threshold = 1

[[cases]]
id = "clip"
kind = "clipping"
asset = "mark"
sizes = [[16, 16]]
backgrounds = ["token:black"]
forbidden_edge_pixels = 1

[[cases]]
id = "padding"
kind = "visible-padding"
asset = "mark"
sizes = [[16, 16]]
backgrounds = ["transparent"]
minimum_padding_ratio = 100000

[[cases]]
id = "small"
kind = "small-size-visibility"
asset = "mark"
sizes = [[16, 16]]
backgrounds = ["transparent"]
minimum_visible_pixels = 1
`;

describe("brand QA schema 1", () => {
  it("parses every case kind and canonically serializes parse/serialize/parse", () => {
    const first = unwrap(parseBrandQaToml(BASE));
    const serialized = serializeBrandQaToml(first);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(unwrap(parseBrandQaToml(serialized))).toEqual(first);
    expect(first.cases.map((entry) => entry.kind)).toEqual([
      "accessibility", "canvas", "clipping", "embedded-content", "external-reference", "inventory", "visible-padding", "palette", "pixel-bounds", "recipe", "small-size-visibility", "transparent-bounds",
    ]);
    expect(computeBrandQaDigest(first)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(encodeCanonicalJson(toBrandQaCanonicalDto(first))).not.toContain(" ");
  });

  it("parses the converged producer example with no semantic aliases", () => {
    const source = readRepoFile("docs/examples/v0.4/brand-system/producer/.tfsb/brand-qa.toml");
    expect(source).not.toMatch(/(?:\[|,\s*)"(?:light|dark|white|black)"/u);
    expect(unwrap(parseBrandQaToml(source)).cases).toHaveLength(7);
  });

  it.each(["light", "dark", "white", "black"])("rejects unprefixed background %s", (value) => {
    expect(parseBrandQaToml(BASE.replace('backgrounds = ["transparent"]', `backgrounds = ["${value}"]`)).ok).toBe(false);
  });

  it("rejects unknown, missing, duplicate, and incompatible target fields", () => {
    expect(parseBrandQaToml(BASE.replace('family = "core"\n\n[[cases]]', 'family = "core"\nunknown = true\n\n[[cases]]')).ok).toBe(false);
    expect(parseBrandQaToml(BASE.replace('asset = "mark"\nallowed_tokens', 'asset = "mark"\nfamily = "core"\nallowed_tokens')).ok).toBe(false);
    expect(parseBrandQaToml(BASE.replace('id = "accessibility"', 'id = "inventory"')).ok).toBe(false);
    expect(parseBrandQaToml(BASE.replace('cases = ["inventory",', 'cases = ["missing",')).ok).toBe(false);
    expect(parseBrandQaToml(BASE.replace('family = "core"\n\n[[cases]]', 'family = "core"\nroles = ["not a role"]\n\n[[cases]]')).ok).toBe(false);
  });

  it("accepts exact dimension/pixel boundaries and rejects boundary plus one", () => {
    const boundary = BASE.replaceAll("[[16, 16]]", `[[${BRAND_QA_MAX_DIMENSION}, 1024]]`);
    expect(parseBrandQaToml(boundary).ok).toBe(true);
    expect(parseBrandQaToml(boundary.replace(`${BRAND_QA_MAX_DIMENSION}, 1024`, `${BRAND_QA_MAX_DIMENSION + 1}, 1024`)).ok).toBe(false);
    expect(parseBrandQaToml(BASE + "#".repeat(BRAND_QA_MAX_BYTES)).ok).toBe(false);
  });

  it("rejects BOM, floats, duplicate profile cases, and baseline multiplicity/path mismatch", () => {
    expect(parseBrandQaToml("\uFEFF" + BASE).ok).toBe(false);
    expect(parseBrandQaToml(BASE.replace("minimum_padding_ratio = 100000", "minimum_padding_ratio = 0.1")).ok).toBe(false);
    expect(parseBrandQaToml(BASE.replace('cases = ["inventory",', 'cases = ["inventory", "inventory",')).ok).toBe(false);
    const baseline = BASE.replace('cases = ["inventory",', 'cases = ["baseline", "inventory",') + `
[[cases]]
id = "baseline"
kind = "baseline"
asset = "mark"
sizes = [[16, 16], [32, 32]]
backgrounds = ["transparent"]
baseline_path = ".tfsb/brand-baselines/release/baseline.png"
baseline_digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
renderer_id = "fake"
renderer_version = "1"
platform_claim = "test"
canonical_asset_digest = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
svg_digest = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
`;
    expect(parseBrandQaToml(baseline).ok).toBe(false);
  });
});
