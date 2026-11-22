import type { HexColor } from "../types.js";
import { ILLUSTRATION_SCENE_LIMITS, SCENE_COMPATIBILITY, SCENE_COMPILER_LEVEL, SCENE_LIMITS, SCENE_SCHEMA } from "./constants.js";
import type { PathElement, VectorScene } from "./types.js";

interface PixelSource {
  readonly width: number;
  readonly height: number;
  readonly rgba8: Uint8Array;
}

type ChannelBits = 5 | 6;
type Color = [number, number, number];
type Sample = { key: number; count: number; sum: Color };
type Bucket = { samples: Sample[]; axis: number; score: number };
const MAX_SOURCE_PIXELS = 4_194_304;
const MAX_TRACE_EDGE = 576;
class TraceContourLimitError extends RangeError {}

function traceGrid(source: PixelSource) {
  const { width, height, rgba8 } = source;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width * height > MAX_SOURCE_PIXELS || rgba8.length !== width * height * 4) {
    throw new RangeError("Raster tracing requires a bounded RGBA8 image.");
  }
  const scale = Math.min(1, MAX_TRACE_EDGE / Math.max(width, height));
  return { cols: Math.max(1, Math.round(width * scale)), rows: Math.max(1, Math.round(height * scale)) };
}

interface SampledRaster {
  readonly cols: number;
  readonly rows: number;
  readonly bits: ChannelBits;
  readonly keys: Uint32Array;
  readonly histogram: Map<number, Sample>;
}

function makeSamples(cols: number, rows: number, bits: ChannelBits): SampledRaster {
  return { cols, rows, bits, keys: new Uint32Array(cols * rows), histogram: new Map() };
}

function sampleCell(source: PixelSource, cols: number, rows: number, x: number, y: number): Color {
  const { width, height, rgba8 } = source;
  const left = x * width, right = (x + 1) * width;
  const top = y * height, bottom = (y + 1) * height;
  const sum: Color = [0, 0, 0];
  // Integrate exact pixel coverage with integer weights.
  for (let sy = Math.floor(top / rows); sy < Math.ceil(bottom / rows); sy += 1) {
    const overlapY = Math.min(bottom, (sy + 1) * rows) - Math.max(top, sy * rows);
    for (let sx = Math.floor(left / cols); sx < Math.ceil(right / cols); sx += 1) {
      const overlapX = Math.min(right, (sx + 1) * cols) - Math.max(left, sx * cols);
      const weight = overlapX * overlapY;
      const index = (sy * width + sx) * 4;
      if (rgba8[index + 3] !== 255) throw new RangeError("Raster tracing requires opaque pixels.");
      sum[0] += rgba8[index]! * weight;
      sum[1] += rgba8[index + 1]! * weight;
      sum[2] += rgba8[index + 2]! * weight;
    }
  }
  return sum.map((value) => Math.round(value / (width * height))) as Color;
}

function recordColor({ bits, keys, histogram }: SampledRaster, i: number, rgb: Color) {
  const shift = 8 - bits;
  const key = ((rgb[0] >> shift) << (2 * bits)) | ((rgb[1] >> shift) << bits) | (rgb[2] >> shift);
  keys[i] = key;
  const sample = histogram.get(key);
  if (sample === undefined) histogram.set(key, { key, count: 1, sum: [...rgb] });
  else {
    sample.count += 1;
    for (let axis = 0; axis < 3; axis += 1) sample.sum[axis]! += rgb[axis]!;
  }
}

function sampleRaster(source: PixelSource, bits: ChannelBits, { cols, rows }: { cols: number; rows: number }) {
  const sampled = makeSamples(cols, rows, bits);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      recordColor(sampled, y * cols + x, sampleCell(source, cols, rows, x, y));
    }
  }
  return sampled;
}

function sampleAdaptiveRaster(
  source: PixelSource, coarse: { cols: number; rows: number }, edgeThreshold: number,
): SampledRaster {
  const cols = coarse.cols * 2, rows = coarse.rows * 2;
  const sampled = makeSamples(cols, rows, 6);
  for (let y = 0; y < coarse.rows; y += 1) {
    for (let x = 0; x < coarse.cols; x += 1) {
      const left = 2 * x, top = 2 * y;
      const subcells = [
        sampleCell(source, cols, rows, left, top),
        sampleCell(source, cols, rows, left + 1, top),
        sampleCell(source, cols, rows, left, top + 1),
        sampleCell(source, cols, rows, left + 1, top + 1),
      ];
      // Subdivide only where the four samples span a strong color transition.
      const resolveEdge = [0, 1, 2].some((channel) => {
        const values = subcells.map((rgb) => rgb[channel]!);
        return Math.max(...values) - Math.min(...values) >= edgeThreshold;
      });
      const shared = resolveEdge ? undefined : sampleCell(source, coarse.cols, coarse.rows, x, y);
      subcells.forEach((color, offset) => {
        const index = (top + (offset >> 1)) * cols + left + (offset & 1);
        recordColor(sampled, index, shared ?? color);
      });
    }
  }
  return sampled;
}

function channel(key: number, axis: number, bits: ChannelBits): number {
  return (key >> ((2 - axis) * bits)) & ((1 << bits) - 1);
}

function partition(samples: Sample[], bits: ChannelBits): Bucket {
  let axis = 0;
  let score = 0;
  for (let c = 0; c < 3; c += 1) {
    let minimum = (1 << bits) - 1, maximum = 0, count = 0;
    for (const sample of samples) {
      const level = channel(sample.key, c, bits);
      minimum = Math.min(minimum, level);
      maximum = Math.max(maximum, level);
      count += sample.count;
    }
    const weight = (maximum - minimum) ** 2 * count;
    if (weight > score) { axis = c; score = weight; }
  }
  return { samples, axis, score };
}

function average(items: readonly Sample[]): Color {
  const sum: Color = [0, 0, 0];
  let count = 0;
  for (const item of items) {
    count += item.count;
    sum[0] += item.sum[0];
    sum[1] += item.sum[1];
    sum[2] += item.sum[2];
  }
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

function nearestColor(rgb: Color, centers: readonly Color[]): number {
  let best = 0, distance = Infinity;
  for (let i = 0; i < centers.length; i += 1) {
    const color = centers[i]!;
    const error = (rgb[0] - color[0]) ** 2 + (rgb[1] - color[1]) ** 2 + (rgb[2] - color[2]) ** 2;
    if (error < distance) { distance = error; best = i; }
  }
  return best;
}

function quantize(samples: readonly Sample[], paletteSize: number, bits: ChannelBits) {
  const buckets = [partition([...samples], bits)];
  while (buckets.length < paletteSize) {
    buckets.sort((a, b) => b.score - a.score);
    const { samples: items, axis, score } = buckets[0]!;
    if (score === 0) break;
    items.sort((a, b) => channel(a.key, axis, bits) - channel(b.key, axis, bits) || a.key - b.key);
    const midpoint = items.reduce((total, item) => total + item.count, 0) / 2;
    let split = 1, cumulative = items[0]!.count;
    while (split < items.length - 1 && cumulative < midpoint) cumulative += items[split++]!.count;
    buckets.splice(0, 1, partition(items.slice(0, split), bits), partition(items.slice(split), bits));
  }
  const indices = new Uint16Array(1 << (3 * bits));
  const centers = buckets.map(({ samples: items }) => average(items));
  const points = samples.map((sample) => ({ sample, rgb: average([sample]) }));
  // Use median-cut for deterministic initialization, then assign each
  // occupied bin to its closest color and refine the palette in place.
  for (let pass = 0; pass < 4; pass += 1) {
    const assigned = centers.map((): Sample[] => []);
    for (const { sample, rgb } of points) {
      const best = nearestColor(rgb, centers);
      indices[sample.key] = best;
      assigned[best]!.push(sample);
    }
    if (pass < 3) {
      assigned.forEach((items, i) => {
        if (items.length) centers[i] = average(items);
      });
    }
  }
  const colors = centers.map((rgb) =>
    `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}` as HexColor);
  return { indices, colors, centers };
}

function traceContours(pixels: Uint16Array, width: number, height: number, count: number, relativePaths: boolean) {
  const stride = width + 1;
  const steps = [1, stride, -1, -stride];
  const edges = Array.from({ length: count }, () => new Set<number>());
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const color = pixels[i]!;
      const corner = y * stride + x;
      const boundary = edges[color]!;
      if (y === 0 || pixels[i - width] !== color) boundary.add(4 * corner);
      if (x === width - 1 || pixels[i + 1] !== color) boundary.add(4 * (corner + 1) + 1);
      if (y === height - 1 || pixels[i + width] !== color) boundary.add(4 * (corner + stride + 1) + 2);
      if (x === 0 || pixels[i - 1] !== color) boundary.add(4 * (corner + stride) + 3);
    }
  }
  return edges.map((boundary) => {
    const contours: string[] = [];
    let segments = 0;
    let previousStart: number | undefined;
    for (const first of boundary) {
      const start = Math.floor(first / 4);
      let direction = first % 4, vertex = start;
      let path = `M${vertex % stride} ${Math.floor(vertex / stride)}`;
      // Closepath resets the current point to the preceding subpath start.
      if (relativePaths && previousStart !== undefined) {
        const dx = vertex % stride - previousStart % stride;
        const dy = Math.floor(vertex / stride) - Math.floor(previousStart / stride);
        const move = `m${dx} ${dy}`;
        if (move.length < path.length) path = move;
      }
      previousStart = start;
      let lastCorner = start;
      segments += 2; // Move and close commands.
      do {
        boundary.delete(vertex * 4 + direction);
        vertex += steps[direction]!;
        if (vertex === start) break;
        // Clockwise edges keep the filled region on their right. Prefer a
        // right turn at a diagonal contact so point-touching loops stay apart.
        const next = [1, 0, 3].map((offset) => (direction + offset) % 4)
          .find((candidate) => boundary.has(vertex * 4 + candidate));
        if (next === undefined) throw new Error("Raster contour did not close.");
        if (direction !== next) {
          const horizontal = direction % 2 === 0;
          const target = horizontal ? vertex % stride : Math.floor(vertex / stride);
          let line = `${horizontal ? "H" : "V"}${target}`;
          if (relativePaths) {
            const from = horizontal ? lastCorner % stride : Math.floor(lastCorner / stride);
            const relative = `${horizontal ? "h" : "v"}${target - from}`;
            if (relative.length < line.length) line = relative;
          }
          path += line;
          lastCorner = vertex;
          segments += 1;
        }
        direction = next;
      } while (true);
      contours.push(path + "Z");
    }
    return { contours, segments };
  });
}

interface TraceSettings {
  paletteSize: number;
  block?: 2 | 4;
  segmentLimit?: number;
  underpaintColors?: number;
  underpaintSource?: SampledRaster;
}

function traceSampledRaster(
  source: PixelSource,
  sampled: SampledRaster,
  { paletteSize, block = 2, segmentLimit = Infinity, underpaintColors, underpaintSource = sampled }: TraceSettings,
): VectorScene {
  const { cols, rows, keys, histogram, bits } = sampled;
  const samples = [...histogram.values()];
  const { indices, colors, centers } = quantize(samples, paletteSize, bits);
  const pixels = Uint16Array.from(keys, (key) => indices[key]!);
  const elements: PathElement[] = [];
  let totalSegments = 0;

  const base = { type: "solid", color: colors[0]! } as const;

  function addLayer(
    data: Uint16Array, width: number, height: number, name: string, scale: number, palette = colors, scaleY = scale,
  ) {
    const shapes = traceContours(data, width, height, palette.length, underpaintColors !== undefined);
    shapes.forEach(({ contours, segments }, index) => {
      totalSegments += segments;
      if (totalSegments > segmentLimit) throw new TraceContourLimitError("Raster contours exceed the scene path segment limit.");
      const fill = { type: "solid", color: palette[index]! } as const;
      const d = contours.join("");
      if (d.length > SCENE_LIMITS.maxPathBytes) throw new TraceContourLimitError("Raster contours exceed the per-color path limit.");
      if (d) elements.push({
        type: "path", id: `trace-${name}-${index}`, d, presentation: { fill },
        ...(scale === 1 && scaleY === 1 ? {} : { transform: [{ type: "scale", x: scale, ...(scaleY === scale ? {} : { y: scaleY }) }] }),
      });
    });
  }
  // Similar underpainting remains visible through fractional-pixel seams.
  if (cols > 4 && rows > 4) {
    totalSegments += 5; // One move, three sides, and close.
    elements.push({ type: "path", id: "trace-base", d: `M0 0H${cols}V${rows}H0Z`, presentation: { fill: base } });
    if (underpaintColors !== undefined) {
      const paintGrid = underpaintSource;
      const underpaint = quantize([...paintGrid.histogram.values()], underpaintColors, paintGrid.bits);
      const paint = Uint16Array.from(paintGrid.keys, (key) => underpaint.indices[key]!);
      addLayer(paint, paintGrid.cols, paintGrid.rows, "undercoat",
        cols / paintGrid.cols, underpaint.colors, rows / paintGrid.rows);
    } else {
      const underCols = Math.ceil(cols / block);
      const underRows = Math.ceil(rows / block);
      const undercoat = new Uint16Array(underCols * underRows);
      for (let y = 0; y < underRows; y += 1) {
        for (let x = 0; x < underCols; x += 1) {
          const right = Math.min((x + 1) * block, cols);
          const bottom = Math.min((y + 1) * block, rows);
          const sum: Color = [0, 0, 0];
          const count = (right - x * block) * (bottom - y * block);
          for (let sy = y * block; sy < bottom; sy += 1) {
            for (let sx = x * block; sx < right; sx += 1) {
              const color = centers[pixels[sy * cols + sx]!]!;
              sum[0] += color[0];
              sum[1] += color[1];
              sum[2] += color[2];
            }
          }
          undercoat[y * underCols + x] = nearestColor([sum[0] / count, sum[1] / count, sum[2] / count], centers);
        }
      }
      addLayer(undercoat, underCols, underRows, "undercoat", block);
    }
  }
  addLayer(pixels, cols, rows, "detail", 1);
  return {
    schema: SCENE_SCHEMA, compatibility: SCENE_COMPATIBILITY, compilerLevel: SCENE_COMPILER_LEVEL,
    profile: "illustration",
    artboard: { width: source.width, height: source.height, viewBox: [0, 0, cols, rows] },
    accessibility: { mode: "labelled", title: "Traced illustration" },
    elements,
  };
}

/** Trace opaque sRGB photos or illustrations as editable, palette-colored contours. */
export function traceRasterScene(source: PixelSource, options: { readonly highDetail?: boolean } = {}): VectorScene {
  const grid = traceGrid(source);
  const segmentLimit = SCENE_LIMITS.maxAggregatePathSegments;
  if (options.highDetail && grid.cols * 2 <= source.width && grid.rows * 2 <= source.height
      && grid.cols > 4 && grid.rows > 4) {
    const underpaintSource = sampleRaster(source, 6, { cols: Math.ceil(grid.cols / 2), rows: Math.ceil(grid.rows / 2) });
    for (const settings of [
      { edgeThreshold: 24, paletteSize: 576, underpaintColors: 96, segmentLimit: ILLUSTRATION_SCENE_LIMITS.maxAggregatePathSegments },
      { edgeThreshold: 48, paletteSize: 352, underpaintColors: 128, segmentLimit },
    ]) {
      try {
        const sampled = sampleAdaptiveRaster(source, grid, settings.edgeThreshold);
        return traceSampledRaster(source, sampled, { ...settings, underpaintSource });
      } catch (error) {
        if (!(error instanceof TraceContourLimitError)) throw error;
      }
    }
  }
  try {
    return traceSampledRaster(source, sampleRaster(source, 6, grid), {
      paletteSize: 448, underpaintColors: 96, segmentLimit,
    });
  } catch (error) {
    if (!(error instanceof TraceContourLimitError)) throw error;
  }
  const sampled = sampleRaster(source, 5, grid);
  try {
    return traceSampledRaster(source, sampled, { paletteSize: 256, block: 2, segmentLimit });
  } catch (error) {
    if (!(error instanceof TraceContourLimitError)) throw error;
    return traceSampledRaster(source, sampled, { paletteSize: 160, block: 4 });
  }
}
