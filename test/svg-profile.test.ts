import { describe, expect, it } from "vitest";

import { parseSvg } from "../src/index.js";
import { firstCode, unwrap } from "./helpers.js";

const svg = (body: string, extraRoot = "") => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" role="img" aria-labelledby="title desc"${extraRoot}>
  <title id="title">Title</title>
  <desc id="desc">Description</desc>
  ${body}
</svg>`;

describe("safe closed SVG profile", () => {
  it.each([
    ["malformed XML", svg('<path d="M0 0L1 1">'), "XML_SYNTAX"],
    ["DOCTYPE", `<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>`, "XML_UNSAFE_DECLARATION"],
    ["entity declaration", `<!DOCTYPE svg [<!ENTITY x "x">]>${svg('<path d="M0 0L1 1"/>')}`, "XML_UNSAFE_DECLARATION"],
    ["undeclared entity", svg('<path d="M0 0L1 1"/>').replace("Title", "&unknown;"), "XML_SYNTAX"],
    ["processing instruction", `<?work now?>${svg('<path d="M0 0L1 1"/>')}`, "XML_UNSUPPORTED_PROCESSING_INSTRUCTION"],
    ["wrong namespace", svg('<path d="M0 0L1 1"/>').replace("http://www.w3.org/2000/svg", "urn:not-svg"), "XML_UNSUPPORTED_NAMESPACE"],
    ["event handler", svg('<path onclick="run()" d="M0 0L1 1"/>'), "XML_ACTIVE_CONTENT"],
    ["style attribute", svg('<path style="fill:red" d="M0 0L1 1"/>'), "XML_ACTIVE_CONTENT"],
    ["external href", svg('<use href="https://example.invalid/a.svg#p"/>'), "XML_EXTERNAL_REFERENCE"],
    ["data URL paint", svg('<path fill="url(data:image/svg+xml,x)" d="M0 0L1 1"/>'), "XML_EXTERNAL_REFERENCE"],
    ["unknown attribute", svg('<path vector-effect="non-scaling-stroke" d="M0 0L1 1"/>'), "XML_UNSUPPORTED_ATTRIBUTE"],
    ["unsupported transform", svg('<path transform="rotate(4)" d="M0 0L1 1"/>'), "XML_INVALID_TRANSFORM"],
    ["nested metadata", svg('<metadata><b>bad</b></metadata><path d="M0 0L1 1"/>'), "XML_UNSUPPORTED_MARKUP"],
  ])("rejects %s", (_name, text, code) => {
    expect(firstCode(parseSvg(text))).toBe(code);
  });

  it.each([
    "script",
    "image",
    "foreignObject",
    "style",
    "filter",
    "mask",
    "clipPath",
    "animate",
    "text",
    "pattern",
    "marker",
    "symbol",
    "radialGradient",
  ])("rejects excluded <%s> content", (tag) => {
    expect(parseSvg(svg(`<${tag}/>`)).ok).toBe(false);
  });

  it("rejects duplicate IDs", () => {
    expect(
      firstCode(parseSvg(svg('<g id="same"><path id="same" d="M0 0L1 1"/></g>'))),
    ).toBe("REFERENCE_DUPLICATE_ID");
  });

  it("requires named path definitions", () => {
    expect(
      firstCode(parseSvg(svg('<defs><path d="M0 0L1 1"/></defs><path d="M0 0L1 1"/>'))),
    ).toBe("XML_MISSING_ATTRIBUTE");
  });

  it("rejects invalid path tokens without skipping characters", () => {
    expect(firstCode(parseSvg(svg('<path d="M0 0 @ L1 1"/>')))).toBe(
      "XML_INVALID_PATH_DATA",
    );
  });

  it("rejects unresolved local href and paint references", () => {
    expect(firstCode(parseSvg(svg('<use href="#missing"/>')))).toBe("REFERENCE_UNRESOLVED");
    expect(
      firstCode(parseSvg(svg('<path fill="url(#missing) #000000" d="M0 0L1 1"/>'))),
    ).toBe("REFERENCE_UNRESOLVED");
  });

  it("accepts and discards comments as non-semantic", () => {
    const without = unwrap(parseSvg(svg('<path d="M0 0L1 1"/>')));
    const withComment = unwrap(
      parseSvg(svg('<!-- mentions <!DOCTYPE without activating it -->\n<path d="M0 0L1 1"/>')),
    );
    expect(withComment).toEqual(without);
  });

  it("rejects percentage offsets outside the normalized range", () => {
    const text = svg(`
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#000000"/>
          <stop offset="101%" stop-color="#FFFFFF"/>
        </linearGradient>
      </defs>
      <path fill="url(#g)" d="M0 0L1 1"/>
    `);
    expect(firstCode(parseSvg(text))).toBe("XML_INVALID_RANGE");
  });
});
