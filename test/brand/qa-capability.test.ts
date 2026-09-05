import { describe, expect, it } from "vitest";

import { BRAND_QA_RENDER_CONFIGURATION, compareBrandQaRasters, countBrandQaForbiddenEdgePixels, measureBrandQaRaster, renderBrandQaRaster, validateBrandQaNormalizedRaster, validateBrandQaRendererDescriptor, type BrandQaRendererCapability } from "../../src/index.js";

function raster(width: number, height: number, visible: readonly [number, number][] = []) {
  const rgba8 = new Uint8Array(width * height * 4);
  for (const [x, y] of visible) rgba8.set([255, 0, 0, 255], (y * width + x) * 4);
  return { width, height, rgba8, pngBytes: new Uint8Array([137, 80, 78, 71]) };
}

const descriptor = Object.freeze({ id: "fake-renderer", version: "1", qualificationId: "qa-test", platformClaim: "portable-test" });

describe("brand QA renderer capability", () => {
  it("validates the closed descriptor and rejects mismatches/extra fields", () => {
    expect(validateBrandQaRendererDescriptor(descriptor)).toEqual(descriptor);
    expect(() => validateBrandQaRendererDescriptor(descriptor, { version: "2" })).toThrow(/mismatch/u);
    expect(() => validateBrandQaRendererDescriptor({ ...descriptor, extra: true } as never)).toThrow(/fields/u);
  });

  it("copies exact bounded input and validates dimensions/RGBA without trusting assertions", async () => {
    let requestSeen = false;
    const capability: BrandQaRendererCapability = {
      descriptor,
      renderSvg(input) {
        requestSeen = true;
        expect(Object.keys(input).sort()).toEqual(["background", "backgroundRgba", "canonicalSvgBytes", "configuration", "height", "svgDigest", "width"]);
        return raster(input.width, input.height, [[1, 1]]);
      },
      decodePng(input) { return raster(input.expectedWidth, input.expectedHeight); },
    };
    const result = await renderBrandQaRaster(capability, { canonicalSvgBytes: new Uint8Array([60, 115, 118, 103, 62]), svgDigest: "sha256:" + "1".repeat(64) as never, width: 3, height: 3, background: "transparent", backgroundRgba: null, configuration: BRAND_QA_RENDER_CONFIGURATION }, { decodedRgbaBytes: 0 });
    expect(requestSeen).toBe(true);
    expect(result.rgba8).toHaveLength(36);
    expect(() => validateBrandQaNormalizedRaster({ width: 3, height: 3, rgba8: new Uint8Array(35) }, 3, 3)).toThrow(/length/u);
    expect(() => validateBrandQaNormalizedRaster({ width: 4, height: 3, rgba8: new Uint8Array(48) }, 3, 3)).toThrow(/dimensions/u);
    expect(() => validateBrandQaNormalizedRaster({ ...raster(3, 3), assertion: "pass" } as never, 3, 3)).toThrow(/fields/u);
  });

  it("computes bounds, alpha-only visibility, clipping, and raster differences in core", () => {
    const first = raster(4, 4, [[1, 1], [2, 2]]);
    expect(measureBrandQaRaster(first, null)).toMatchObject({ visiblePixels: 2, bounds: { left: 1, top: 1, right: 2, bottom: 2 }, topPadding: 1, rightPadding: 1, bottomPadding: 1, leftPadding: 1 });
    expect(countBrandQaForbiddenEdgePixels(first, null, 1)).toBe(0);
    const edge = raster(4, 4, [[0, 1]]);
    expect(countBrandQaForbiddenEdgePixels(edge, null, 1)).toBe(1);
    const hidden = raster(1, 1);
    hidden.rgba8.set([255, 255, 255, 0]);
    expect(measureBrandQaRaster(hidden, null, 0, true).visiblePixels).toBe(0);
    const second = raster(4, 4, [[1, 1], [3, 3]]);
    expect(compareBrandQaRasters(first, second)).toMatchObject({ changedPixels: 2, maximumChannelDelta: 255, changedBounds: { left: 2, top: 2, right: 3, bottom: 3 } });
  });

  it("accepts exact pixel and aggregate RGBA boundaries and rejects boundary plus one", () => {
    const width = 16_384, height = 1_024;
    const rgba8 = new Uint8Array(width * height * 4);
    const budget = { decodedRgbaBytes: 192 * 1_048_576 };
    expect(validateBrandQaNormalizedRaster({ width, height, rgba8 }, width, height, budget).rgba8.byteLength).toBe(64 * 1_048_576);
    expect(budget.decodedRgbaBytes).toBe(256 * 1_048_576);
    expect(() => validateBrandQaNormalizedRaster({ width: 1, height: 1, rgba8: new Uint8Array(4) }, 1, 1, budget)).toThrow(/aggregate/u);
    expect(() => validateBrandQaNormalizedRaster({ width: 16_384, height: 1_025, rgba8: new Uint8Array(16_384 * 1_025 * 4) }, 16_384, 1_025)).toThrow(/pixel limit/u);
  });
});
