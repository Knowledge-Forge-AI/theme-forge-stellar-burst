import { describe, expect, it } from "vitest";

import { fromCaught } from "../src/diagnostics.js";
import { parseAssetToml, parseSvg, serializeSvg } from "../src/index.js";
import type { SvgDocument } from "../src/types.js";
import { firstCode, unwrap } from "./helpers.js";

const assetToml = (d: string) => `
schema_version = 1
id = "arc"
filename = "arc.svg"

[canvas]
width = 20
height = 20
view_box = "0 0 20 20"
shape_rendering = "auto"

[accessibility]
title = "Arc"
title_id = "arc-title"
description = "Compact arc syntax"
description_id = "arc-desc"

[[definitions.linear_gradients]]
id = "gradient"
x1 = 0
y1 = 0
x2 = 1
y2 = 1
units = "objectBoundingBox"
stops = [
  { offset = 0, color = "#ff8a3d" },
  { offset = 1, color = "#8b5cf6" },
]

[[elements]]
type = "path"
fill = "url(#gradient)"
d = "${d}"
`;

describe("TFSB1 regression hardening", () => {
  it.each([
    "M0 0 A5 5 0 0110 10",
    "M0 0A5 5 0 005 5",
    "M0 0 A10 10 0 1 1 20 20",
  ])("accepts legal compact arc flags while preserving normalized d: %s", (d) => {
    const asset = unwrap(parseAssetToml(assetToml(d)));
    expect(asset.svg.elements[0]).toMatchObject({ type: "path", d });
  });

  it.each([
    "M0 0 A5 5 0 2 1 10 10",
    "M0 0 A-5 5 0 0 1 10 10",
    "M0 0 A5 5 0 01",
  ])("rejects malformed arc syntax: %s", (d) => {
    expect(firstCode(parseAssetToml(assetToml(d)))).toBe(
      "SCHEMA_INVALID_PATH_DATA",
    );
  });

  it("normalizes schema-1 default attributes and hex case", () => {
    const asset = unwrap(parseAssetToml(assetToml("M0 0L20 20")));
    expect(asset.svg.canvas.shapeRendering).toBeUndefined();
    expect(asset.svg.definitions.linearGradients[0]?.units).toBeUndefined();
    expect(asset.svg.definitions.linearGradients[0]?.stops[0]?.color).toBe(
      "#FF8A3D",
    );
    const serialized = unwrap(serializeSvg(asset.svg));
    expect(serialized).not.toContain("shape-rendering");
    expect(serialized).not.toContain("gradientUnits");
    expect(serialized).toContain('stop-color="#FF8A3D"');
  });

  it("accepts a UTF-8 BOM with and without an XML declaration and in TOML", () => {
    const withoutDeclaration = `\uFEFF<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" role="img" aria-labelledby="t d"><title id="t">T</title><desc id="d">D</desc><path d="M0 0L1 1"/></svg>`;
    const withDeclaration = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>${withoutDeclaration.slice(1)}`;
    expect(parseSvg(withoutDeclaration).ok).toBe(true);
    expect(parseSvg(withDeclaration).ok).toBe(true);
    expect(parseAssetToml(`\uFEFF${assetToml("M0 0L1 1")}`).ok).toBe(true);
  });

  it("preserves source and useful locations for representative diagnostics", () => {
    const toml = parseAssetToml(assetToml("M0 0L1 1").replace("width = 20", "width = 0"), "asset.toml");
    expect(toml).toMatchObject({
      ok: false,
      diagnostics: [{ source: "asset.toml", location: "canvas.width" }],
    });

    const xml = parseSvg("<not-svg/>", "asset.svg");
    expect(xml).toMatchObject({
      ok: false,
      diagnostics: [{ source: "asset.svg", location: "/" }],
    });
  });

  it("does not relabel unexpected internal failures as user diagnostics", () => {
    const internal = new Error("programmer invariant failed");
    expect(() =>
      fromCaught<SvgDocument>(
        internal,
        { operation: "serialize", domain: "svg" },
        "XML_SYNTAX",
        "Invalid XML.",
      ),
    ).toThrow(internal);
  });
});
