export interface RgbaRaster {
  readonly rgba8: Uint8Array;
  readonly width: number;
  readonly height: number;
}

interface SourceSpan {
  readonly first: number;
  readonly overlap: Uint16Array;
}

function sourceSpans(sourceSize: number, outputSize: number): SourceSpan[] {
  return Array.from({ length: outputSize }, (_, outputIndex) => {
    // All coordinates are integers in a grid scaled by the output dimension.
    const start = outputIndex * sourceSize;
    const end = start + sourceSize;
    const first = Math.floor(start / outputSize);
    const last = Math.ceil(end / outputSize);
    const overlap = new Uint16Array(last - first);
    for (let index = first; index < last; index += 1) {
      overlap[index - first] = Math.min(end, (index + 1) * outputSize) - Math.max(start, index * outputSize);
    }
    return { first, overlap };
  });
}

/** Downsample a validated sRGB raster using integer coverage and alpha-weighted color. */
export function downsampleArea(source: RgbaRaster, width: number, height: number, checkBudget?: () => void): Uint8Array {
  if (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)
      || source.width < 1 || source.height < 1 || source.width > 16_384 || source.height > 16_384
      || source.width * source.height > 16_777_216 || source.rgba8.length !== source.width * source.height * 4
      || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || width > source.width || height > source.height) {
    throw new RangeError("Area downsampling requires bounded source and output dimensions.");
  }
  const horizontal = sourceSpans(source.width, width);
  const vertical = sourceSpans(source.height, height);
  const area = source.width * source.height;
  const output = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    checkBudget?.();
    const rows = vertical[y]!;
    for (let x = 0; x < width; x += 1) {
      const columns = horizontal[x]!;
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let row = 0; row < rows.overlap.length; row += 1) {
        const start = ((rows.first + row) * source.width + columns.first) * 4;
        for (let column = 0; column < columns.overlap.length; column += 1) {
          const pixel = start + column * 4;
          const weight = columns.overlap[column]! * rows.overlap[row]! * source.rgba8[pixel + 3]!;
          alpha += weight;
          red += weight * source.rgba8[pixel]!;
          green += weight * source.rgba8[pixel + 1]!;
          blue += weight * source.rgba8[pixel + 2]!;
        }
      }
      const pixel = (y * width + x) * 4;
      const opacity = Math.round(alpha / area);
      output[pixel + 3] = opacity;
      if (opacity > 0) {
        output[pixel] = Math.round(red / alpha);
        output[pixel + 1] = Math.round(green / alpha);
        output[pixel + 2] = Math.round(blue / alpha);
      }
    }
  }
  return output;
}
