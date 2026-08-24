import { describe, expect, it } from "vitest";

import {
  parseAssetTomlV2,
  parseSvg,
  parseSvgV2,
  serializeSvg,
  serializeSvgV2,
} from "../src/index.js";
import { scanAnalyzeSvg } from "../src/analyze-scanner.js";
import type { AccessibilityV2, SvgDocumentV2 } from "../src/schema2-types.js";
import { unwrap } from "./helpers.js";

const SCHEMA1_SOURCE = `
<svg xmlns="http://www.w3.org/2000/svg" width="80" height="64" viewBox="0 0 80 64" role="img" aria-labelledby="title desc">
  <title id="title">Canonical schema one</title>
  <desc id="desc">Accepted common profile</desc>
  <metadata>synthetic parity fixture</metadata>
  <defs>
    <path id="glyph" d="M0 0H8"/>
    <linearGradient id="paint-b" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#000000"/>
      <stop offset="1" stop-color="#FFFFFF"/>
    </linearGradient>
  </defs>
  <g transform="translate(1 2) scale(0.5)">
    <use href="#glyph" fill="url(#paint-b) #123456"/>
    <use href="#glyph" fill="url(#paint-b)"/>
  </g>
</svg>`;

const SCHEMA2_TOML = `schema_version = 2
id = "schema-two-parity"
filename = "schema-two-parity.svg"

[canvas]
width = 32
height = 24
view_box = "0 0 32 24"
shape_rendering = "geometricPrecision"

[accessibility]
mode = "labelled"
title = "Schema two parity"
description = "Accepted common profile"
focusable = false

[presentation]
fill = "none"
stroke = "currentColor"
stroke_width = 2
stroke_linecap = "round"
stroke_linejoin = "bevel"
stroke_miterlimit = 2
opacity = 0.8
fill_opacity = 0.7
stroke_opacity = 0.6
fill_rule = "evenodd"
clip_rule = "nonzero"

[[definitions.linear_gradients]]
id = "paint-b"
x1 = 0
y1 = 0
x2 = 1
y2 = 1
stops = [
  { offset = 0, color = "#000000" },
  { offset = 1, color = "#FFFFFF", opacity = 0.5 },
]

[[definitions.paths]]
type = "path"
id = "path-z"
d = "M0 0L1 1"

[[definitions.groups]]
type = "group"
id = "group-a"
children = [
  { type = "use", reference = "path-z", x = 1, y = 2 },
  { type = "circle", cx = 3, cy = 4, r = 2 },
]

[[elements]]
type = "group"
fill_gradient = "paint-b"
fill_fallback = "#123456"
transforms = [
  { type = "translate", x = 2 },
  { type = "rotate", angle = 45, cx = 8, cy = 8 },
  { type = "scale", x = 0.5 },
]
children = [
  { type = "path", d = "M0 0L8 8", stroke_gradient = "paint-b" },
  { type = "use", reference = "group-a", x = 2, y = 3 },
  { type = "circle", cx = 4, cy = 4, r = 3, fill = "#ABCDEF" },
  { type = "ellipse", cx = 8, cy = 4, rx = 3, ry = 2 },
  { type = "rect", x = 1, y = 1, width = 8, height = 6, corner_radius = 2 },
  { type = "line", x1 = 0, y1 = 0, x2 = 8, y2 = 8 },
  { type = "polyline", points = [[0, 0], [1, 1]] },
  { type = "polygon", points = [[0, 0], [2, 0], [1, 2]] },
  { type = "group", children = [{ type = "path", d = "M1 1L2 2", fill = "currentColor" }] },
]
`;

function commonProfile(source: string) {
  return scanAnalyzeSvg(new TextEncoder().encode(source), "canonical.svg", "canonical").file.profiles.commonV03;
}

function expectNoFalseRejection(source: string): void {
  const profile = commonProfile(source);
  expect(profile.classification).not.toBe("unsupported");
  expect(profile.classification).not.toBe("unsafe");
}

function svgWithPaint(paint: string, target = "linearGradient"): string {
  const definition = target === "linearGradient"
    ? '<linearGradient id="paint-b"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient>'
    : '<path id="paint-b" d="M0 0L1 1"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-labelledby="title"><title id="title">Paint</title><defs>${definition}</defs><path fill="${paint}" d="M0 0L1 1"/></svg>`;
}

describe("canonical SVG analyzer parity", () => {
  it("accepts exact schema-1 and schema-2 canonical gradient fallback output", () => {
    const schema1 = unwrap(serializeSvg(unwrap(parseSvg(SCHEMA1_SOURCE))));
    expect(schema1).toContain('fill="url(#paint-b) #123456"');
    expect(unwrap(parseSvg(schema1))).toEqual(unwrap(parseSvg(SCHEMA1_SOURCE)));
    expectNoFalseRejection(schema1);

    const schema2Model = unwrap(parseAssetTomlV2(SCHEMA2_TOML)).svg;
    const schema2 = unwrap(serializeSvgV2(schema2Model));
    expect(schema2).toContain('fill="url(#paint-b) #123456"');
    expect(schema2).toContain('stroke="url(#paint-b)"');
    expect(unwrap(parseSvgV2(schema2))).toEqual(schema2Model);
    const profile = commonProfile(schema2);
    expect(profile.featureCodes).toEqual(expect.arrayContaining(["paint.hex", "paint.linearGradient", "reference.local"]));
    expectNoFalseRejection(schema2);
  });

  it.each(["labelled", "decorative", "consumer_labelled"] as const)("keeps canonical schema-2 %s accessibility inside the common profile", (mode) => {
    const base = unwrap(parseAssetTomlV2(SCHEMA2_TOML)).svg;
    const accessibility: AccessibilityV2 = mode === "labelled"
      ? base.accessibility
      : { mode, focusable: false };
    const model: SvgDocumentV2 = { ...base, accessibility };
    const canonical = unwrap(serializeSvgV2(model));
    expect(unwrap(parseSvgV2(canonical))).toEqual(model);
    expectNoFalseRejection(canonical);
  });

  it.each([
    "url(#paint-b) #123",
    "url(#paint-b) red",
    "url(#paint-b) #123456 #654321",
    "url(#paint-b) var(--fallback)",
    "url(#paint-b",
    "rgb(0 0 0)",
    "hsl(0 0% 0%)",
    "red",
  ])("keeps malformed or broadened paint unsupported: %s", (paint) => {
    expect(commonProfile(svgWithPaint(paint)).diagnosticCodes).toContain("ANALYZE_UNSUPPORTED_PAINT");
  });

  it.each([
    "url(#paint-b)  #123456",
    "url(#paint-b)\t#123456",
    "url(#paint-b)\n#123456",
  ])("classifies accepted noncanonical gradient fallback whitespace as normalization: %s", (paint) => {
    const normalized = commonProfile(svgWithPaint(paint));
    expect(normalized.classification).toBe("importable_with_normalization");
    expect(normalized.diagnosticCodes).not.toContain("ANALYZE_UNSUPPORTED_PAINT");
    expect(normalized.featureCodes).toEqual(expect.arrayContaining(["paint.linearGradient", "reference.local"]));
  });

  it.each([
    ["viewBox", (source: string) => source.replace('viewBox="0 0 10 10"', 'viewBox="0\t0 10 10"')],
    ["path data", (source: string) => source.replace('d="M0 0L1 1"', 'd="M0\t0L1 1"')],
    ["transform", (source: string) => source.replace('<path fill=', '<path transform="translate(1\t2)" fill=')],
    ["points", (source: string) => source.replace('<path fill=', '<polyline points="0,0  5,5"/><path fill=')],
    ["hex paint whitespace", (source: string) => source.replace('fill="url(#paint-b) #123456"', 'fill=" #AABBCC "')],
  ])("classifies parser-accepted noncanonical %s whitespace as normalization", (_label, mutate) => {
    const normalized = commonProfile(mutate(svgWithPaint("url(#paint-b) #123456")));
    expect(normalized.classification).toBe("importable_with_normalization");
    expect(normalized.diagnosticCodes).not.toContain("ANALYZE_UNSUPPORTED_TRANSFORM");
    expect(normalized.diagnosticCodes).not.toContain("ANALYZE_INVALID_PATH_DATA");
  });

  it.each([
    '<defs><path id="pa:nt" d="M0 0L1 1"/></defs><use href="#pa:nt"/>',
    '<defs><linearGradient id="pa:nt"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient></defs><path fill="url(#pa:nt)" d="M0 0L1 1"/>',
  ])("never classifies parser-rejected colon local IDs as direct", (body) => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-labelledby="title"><title id="title">ID parity</title>${body}</svg>`;
    const profile = commonProfile(source);
    expect(profile.classification).toBe("unsupported");
    expect(profile.diagnosticCodes).toEqual(expect.arrayContaining(["ANALYZE_INVALID_ID", "ANALYZE_INVALID_REFERENCE"]));
  });

  it("rejects a gradient fallback whose local target violates the accepted ID grammar", () => {
    const profile = commonProfile(svgWithPaint("url(#1paint) #123456"));
    expect(profile.diagnosticCodes).toEqual(expect.arrayContaining(["ANALYZE_INVALID_REFERENCE", "ANALYZE_UNSUPPORTED_PAINT"]));
  });

  it.each([
    "url(https://example.invalid/paint.svg#paint-b)",
    "url(data:image/svg+xml,seed)",
    "url(//example.invalid/paint.svg#paint-b)",
  ])("keeps external paint unsafe: %s", (paint) => {
    const profile = commonProfile(svgWithPaint(paint));
    expect(profile.classification).toBe("unsafe");
    expect(profile.diagnosticCodes).toContain("ANALYZE_UNSAFE_EXTERNAL_REFERENCE");
  });

  it.each([
    ["unresolved", svgWithPaint("url(#missing) #123456")],
    ["wrong type", svgWithPaint("url(#paint-b) #123456", "path")],
  ])("retains %s local paint reference authority", (_label, source) => {
    expect(commonProfile(source).diagnosticCodes).toContain("ANALYZE_INVALID_REFERENCE");
  });
});
