import { describe, expect, it } from "vitest";

import { compareBrandVisuals, serializeBrandVisualDiff, type BrandQaRendererCapability } from "../../src/index.js";
import { readRepoFile } from "../helpers.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}` as const;
const capability = (different: boolean): BrandQaRendererCapability => ({
  descriptor: { id: "fake", version: "1", qualificationId: "test", platformClaim: "portable" },
  renderSvg(input) {
    const rgba8 = new Uint8Array(input.width * input.height * 4);
    if (different && input.svgDigest === digest("2")) rgba8.set([255, 255, 255, 255]);
    return { width: input.width, height: input.height, rgba8, pngBytes: new Uint8Array([input.svgDigest === digest("2") ? 2 : 1]) };
  },
  decodePng(input) { return { width: input.expectedWidth, height: input.expectedHeight, rgba8: new Uint8Array(input.expectedWidth * input.expectedHeight * 4) }; },
});

describe("renderer-bound brand visual diff", () => {
  it("labels equal pixels only for the exact renderer and case", async () => {
    const result = await compareBrandVisuals({ caseId: "case", target: "asset", renderer: capability(false), width: 2, height: 2, background: "transparent", backgroundRgba: null, before: { canonicalAssetDigest: digest("3"), modelDigest: digest("4"), svgDigest: digest("1"), canonicalSvgBytes: new Uint8Array([1]) }, after: { canonicalAssetDigest: digest("5"), modelDigest: digest("6"), svgDigest: digest("2"), canonicalSvgBytes: new Uint8Array([2]) } });
    expect(result.claim).toBe("pixel-equal-for-this-renderer-and-case-only");
    expect(result.before.modelDigest).not.toBe(result.after.modelDigest);
    expect(serializeBrandVisualDiff(result)).not.toContain("geometry");
  });

  it("reports exact changed pixels, channel delta, bounds, and digests", async () => {
    const result = await compareBrandVisuals({ caseId: "case", target: "asset", renderer: capability(true), width: 2, height: 2, background: "transparent", backgroundRgba: null, before: { canonicalAssetDigest: digest("3"), modelDigest: digest("4"), svgDigest: digest("1"), canonicalSvgBytes: new Uint8Array([1]) }, after: { canonicalAssetDigest: digest("5"), modelDigest: digest("6"), svgDigest: digest("2"), canonicalSvgBytes: new Uint8Array([2]) } });
    expect(result).toMatchObject({ changedPixels: 1, maximumChannelDelta: 255, changedBounds: { left: 0, top: 0, right: 0, bottom: 0 }, claim: "pixel-different-for-this-renderer-and-case-only" });
    expect(result.beforePngDigest).toMatch(/^sha256:/u);
    expect(result.afterDecodedPixelDigest).toMatch(/^sha256:/u);
  });

  it("keeps the documented visual diff on the executable digest contract", () => {
    expect(() => serializeBrandVisualDiff(JSON.parse(readRepoFile("docs/examples/v0.4/brand-system/results/brand-visual-diff.json")))).not.toThrow();
  });
});
