import { describe, expect, it } from "vitest";

import { downsampleArea } from "../src/illustration/area-resample.js";

function expandedGridReference(rgba8: Uint8Array, sourceWidth: number, sourceHeight: number, width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sums = [0, 0, 0, 0];
      for (let py = y * sourceHeight; py < (y + 1) * sourceHeight; py += 1) {
        for (let px = x * sourceWidth; px < (x + 1) * sourceWidth; px += 1) {
          const pixel = (Math.floor(py / height) * sourceWidth + Math.floor(px / width)) * 4;
          const alpha = rgba8[pixel + 3]!;
          for (let channel = 0; channel < 3; channel += 1) {
            sums[channel] = sums[channel]! + rgba8[pixel + channel]! * alpha;
          }
          sums[3] = sums[3]! + alpha;
        }
      }
      const pixel = (y * width + x) * 4;
      output[pixel + 3] = Math.round(sums[3]! / (sourceWidth * sourceHeight));
      if (output[pixel + 3]! > 0) {
        for (let channel = 0; channel < 3; channel += 1) {
          output[pixel + channel] = Math.round(sums[channel]! / sums[3]!);
        }
      }
    }
  }
  return output;
}

describe("downsampleArea", () => {
  it("matches independent coverage for divisible and fractional source footprints", () => {
    let seed = 0xAB2361C9;
    for (let sourceWidth = 1; sourceWidth <= 8; sourceWidth += 1) {
      for (let sourceHeight = 1; sourceHeight <= 8; sourceHeight += 1) {
        const rgba8 = new Uint8Array(sourceWidth * sourceHeight * 4);
        for (let index = 0; index < rgba8.length; index += 1) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          rgba8[index] = seed >>> 24;
        }
        const original = rgba8.slice();
        for (let width = 1; width <= sourceWidth; width += 1) {
          for (let height = 1; height <= sourceHeight; height += 1) {
            expect(downsampleArea({ rgba8, width: sourceWidth, height: sourceHeight }, width, height))
              .toEqual(expandedGridReference(rgba8, sourceWidth, sourceHeight, width, height));
            expect(rgba8).toEqual(original);
          }
        }
      }
    }
  });

  it("weights color by alpha without propagating hidden colors", () => {
    const rgba8 = Uint8Array.of(255, 0, 0, 0, 0, 0, 255, 255);
    expect(downsampleArea({ rgba8, width: 2, height: 1 }, 1, 1)).toEqual(Uint8Array.of(0, 0, 255, 128));
    rgba8[7] = 0;
    expect(downsampleArea({ rgba8, width: 2, height: 1 }, 1, 1)).toEqual(new Uint8Array(4));
    rgba8[7] = 1;
    expect(downsampleArea({ rgba8: Uint8Array.of(...rgba8, 200, 100, 50, 0), width: 3, height: 1 }, 1, 1))
      .toEqual(new Uint8Array(4));
  });

  it("refuses invalid requests before inspecting source pixels", () => {
    const source = { rgba8: Uint8Array.of(0, 0, 0, 255), width: 1, height: 1 };
    for (const width of [0, -1, 2, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => downsampleArea(source, width, 1)).toThrow(RangeError);
    }
    expect(() => downsampleArea({ ...source, width: 2 }, 1, 1)).toThrow(RangeError);
    expect(() => downsampleArea({ ...source, width: 16_385 }, 1, 1)).toThrow(RangeError);
  });
});
