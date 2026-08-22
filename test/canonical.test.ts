import { describe, expect, it } from "vitest";

import { parseAssetToml, parseSvg, serializeSvg } from "../src/index.js";
import { firstCode, unwrap } from "./helpers.js";

const COMPLEX = `
<svg xmlns="http://www.w3.org/2000/svg" width="8e1" height="64.0" viewBox="-0 .0 80.0 64" role="img" aria-labelledby="title desc" shape-rendering="auto">
  <title id="title">A &amp; B</title>
  <desc id="desc">
    First line
      indented line
  </desc>
  <metadata>
    alpha
    beta
  </metadata>
  <defs>
    <path id="glyph" d="M0 0 H8"/>
    <linearGradient id="gradient" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
      <stop offset="0%" stop-color="#ff8a3d" stop-opacity="1"/>
      <stop offset="52%" stop-color="#e45a9e"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <use href="#glyph" x="-0" y="0" transform="translate(0 0) scale(.720)" fill="url(#gradient) #ff8a3d"/>
</svg>`;

describe("canonical SVG serialization", () => {
  it("normalizes numbers, defaults, transforms, fallback paint, and definition order", () => {
    const model = unwrap(parseSvg(COMPLEX));
    const canonical = unwrap(serializeSvg(model));
    expect(canonical).toContain('width="80" height="64" viewBox="0 0 80 64"');
    expect(canonical).not.toContain("shape-rendering");
    expect(canonical).not.toContain(' x="0"');
    expect(canonical).not.toContain(' y="0"');
    expect(canonical).not.toContain("gradientUnits");
    expect(canonical).not.toContain("stop-opacity");
    expect(canonical).toContain('offset="0.52"');
    expect(canonical).toContain('transform="translate(0) scale(0.72)"');
    expect(canonical).toContain('fill="url(#gradient) #FF8A3D"');
    expect(canonical.indexOf("<linearGradient")).toBeLessThan(canonical.indexOf('<path id="glyph"'));
  });

  it("uses stable element-specific attribute order and XML escaping", () => {
    const canonical = unwrap(serializeSvg(unwrap(parseSvg(COMPLEX))));
    expect(canonical).toContain('<title id="title">A &amp; B</title>');
    expect(canonical).toMatch(
      /<use href="#glyph" fill="url\(#gradient\) #FF8A3D" transform="translate\(0\) scale\(0\.72\)"\/>/,
    );
  });

  it("normalizes accessibility and metadata text", () => {
    const model = unwrap(parseSvg(COMPLEX));
    expect(model.accessibility.description).toBe("First line\n  indented line");
    expect(model.metadataText).toBe("alpha\nbeta");
    const canonical = unwrap(serializeSvg(model));
    expect(unwrap(parseSvg(canonical))).toEqual(model);
  });

  it("is byte-stable across repeated serialization", () => {
    const model = unwrap(parseSvg(COMPLEX));
    const first = unwrap(serializeSvg(model));
    const second = unwrap(serializeSvg(unwrap(parseSvg(first))));
    expect(second).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
  });

  it("returns the specific validation diagnostic for an invalid model", () => {
    const model = unwrap(parseSvg(COMPLEX));
    const path = model.definitions.paths[0];
    expect(path).toBeDefined();
    const invalid = {
      ...model,
      definitions: {
        ...model.definitions,
        paths: [...model.definitions.paths, path!],
      },
    };
    expect(firstCode(serializeSvg(invalid))).toBe("REFERENCE_DUPLICATE_ID");
  });

  it("treats TOML key order as non-semantic", () => {
    const first = `
schema_version = 1
id = "a"
filename = "a.svg"
[canvas]
width = 10
height = 10
view_box = "0 0 10 10"
[accessibility]
title = "T"
title_id = "t"
description = "D"
description_id = "d"
[[elements]]
type = "path"
fill = "#ff0000"
d = "M0 0 L1 1"
`;
    const second = `
filename = "a.svg"
id = "a"
schema_version = 1
[accessibility]
description_id = "d"
description = "D"
title_id = "t"
title = "T"
[canvas]
view_box = "0 0 10 10"
height = 10
width = 10
[[elements]]
d = "M0 0 L1 1"
fill = "#ff0000"
type = "path"
`;
    const firstBytes = unwrap(serializeSvg(unwrap(parseAssetToml(first)).svg));
    const secondBytes = unwrap(serializeSvg(unwrap(parseAssetToml(second)).svg));
    expect(secondBytes).toBe(firstBytes);
  });
});
