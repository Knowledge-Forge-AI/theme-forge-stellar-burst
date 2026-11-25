import { describe, expect, it } from "vitest";
import { guardSvgXml } from "../../src/scene/import-svg-guard.js";

describe("pre-DOM XML resource accounting", () => {
  it("counts depth exactly, including self-closing elements", () => {
    expect(guardSvgXml("<g>".repeat(127) + "<g/>" + "</g>".repeat(127))).toBeUndefined();
    expect(guardSvgXml("<g>".repeat(128) + "<g/>" + "</g>".repeat(128))).toBe("LIMIT_XML_DEPTH_EXCEEDED");
  });
  it("counts comments as nodes at 100000 and 100001", () => {
    expect(guardSvgXml("<svg>" + "<!---->".repeat(99_999) + "</svg>")).toBeUndefined();
    expect(guardSvgXml("<svg>" + "<!---->".repeat(100_000) + "</svg>")).toBe("LIMIT_XML_NODES_EXCEEDED");
  });
  const attrs = (count: number) => Array.from({ length: count }, (_, n) =>
    n % 2 === 0 ? `a${n}="value='with/>syntax'"` : `a${n}='value="with/>syntax"'`,
  ).join(" ");
  it("counts attributes outside quotes at 64 and 65", () => {
    expect(guardSvgXml(`<svg ${attrs(64)}/>`)).toBeUndefined();
    expect(guardSvgXml(`<svg ${attrs(65)}/>`)).toBe("LIMIT_PER_ELEMENT_ATTRIBUTES_EXCEEDED");
  });
  it("counts aggregate attributes at 100000 and 100001", () => {
    const body = `<g ${attrs(64)}/>` .repeat(1562);
    expect(guardSvgXml(`<svg>${body}<g ${attrs(32)}/></svg>`)).toBeUndefined();
    expect(guardSvgXml(`<svg>${body}<g ${attrs(33)}/></svg>`)).toBe("LIMIT_AGGREGATE_ATTRIBUTES_EXCEEDED");
  });
  it("ignores tag-like text inside comments and quoted values", () => {
    expect(guardSvgXml('<svg title="&lt;path/> = &gt;"><!-- <g a="b"> --></svg>')).toBeUndefined();
  });
});
