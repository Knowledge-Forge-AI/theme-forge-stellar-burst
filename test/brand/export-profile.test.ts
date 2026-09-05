import { describe, expect, it } from "vitest";

import {
  BRAND_EXPORT_MAX_DIMENSION,
  BRAND_EXPORT_MAX_PIXELS,
  computeBrandExportOutputDigest,
  computeBrandExportProfileDigest,
  computeBrandExportsDomainDigest,
  computeRawBrandExportsFileDigest,
  parseBrandExportsToml,
  serializeBrandExportsToml,
} from "../../src/brand/export-profile.js";

const source = `schema = "tfsb.brand-exports"
schema_version = 1

[[profiles]]
id = "web-icons"
adapter = "resvg-png-v1"

[[profiles.outputs]]
id = "icon"
purpose = "pwa-icon"
asset = "logo"
destination = "public/icon.png"
width = 192
height = 192
fit = "contain-pad"
background = "transparent"
color_space = "srgb"
alpha = "straight"
`;

describe("brand export profile schema 1", () => {
  it("round trips canonically and computes all four digest identities", () => {
    const parsed = parseBrandExportsToml(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const serialized = serializeBrandExportsToml(parsed.value);
    expect(parseBrandExportsToml(serialized)).toEqual(parsed);
    expect(computeBrandExportsDomainDigest(parsed.value)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeRawBrandExportsFileDigest(parsed.value)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeBrandExportProfileDigest(parsed.value.profiles[0]!)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeBrandExportOutputDigest(parsed.value.profiles[0]!.outputs[0]!)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each(["png", "apple-touch-icon", "pwa-icon", "avatar", "social-card"])("accepts purpose %s", (purpose) => {
    expect(parseBrandExportsToml(source.replace('purpose = "pwa-icon"', `purpose = "${purpose}"`)).ok).toBe(true);
  });

  it("accepts exact dimension and pixel boundaries", () => {
    expect(parseBrandExportsToml(source.replace("width = 192", `width = ${BRAND_EXPORT_MAX_DIMENSION}`).replace("height = 192", "height = 1")).ok).toBe(true);
    expect(parseBrandExportsToml(source.replace("width = 192", "width = 4096").replace("height = 192", "height = 4096")).ok).toBe(true);
    expect(BRAND_EXPORT_MAX_PIXELS).toBe(4096 * 4096);
  });

  it.each([
    ["dimension plus one", source.replace("width = 192", `width = ${BRAND_EXPORT_MAX_DIMENSION + 1}`)],
    ["pixel plus one", source.replace("width = 192", "width = 4096").replace("height = 192", "height = 4097")],
    ["partial selector", source.replace('asset = "logo"', 'family = "brand"\nrole = "mark"')],
    ["two selectors", source.replace('asset = "logo"', 'asset = "logo"\nfamily = "brand"\nrole = "mark"\nvariant = "primary"')],
    ["non-png destination", source.replace("public/icon.png", "public/icon.svg")],
    ["protected destination", source.replace("public/icon.png", ".tfsb/icon.png")],
    ["unknown adapter", source.replace("resvg-png-v1", "arbitrary")],
    ["opaque transparent", source.replace('alpha = "straight"', 'alpha = "opaque"')],
    ["unknown field", source.replace('alpha = "straight"', 'alpha = "straight"\nmodule = "evil"')],
  ])("rejects %s", (_name, value) => expect(parseBrandExportsToml(value).ok).toBe(false));

  it("rejects portable and ancestor destination collisions", () => {
    const duplicated = `${source}\n[[profiles.outputs]]\nid = "other"\npurpose = "png"\nasset = "logo"\ndestination = "PUBLIC/ICON.PNG"\nwidth = 1\nheight = 1\nfit = "contain-pad"\nbackground = "transparent"\ncolor_space = "srgb"\nalpha = "straight"\n`;
    expect(parseBrandExportsToml(duplicated).ok).toBe(false);
  });
});
