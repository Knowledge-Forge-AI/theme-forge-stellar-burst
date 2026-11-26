import { RASTER_MAX_SVG_BYTES } from "../brand/raster-capability.js";
import type { HexColor } from "../types.js";
import { HIGH_DETAIL_SCENE_LIMITS, ILLUSTRATION_SCENE_LIMITS, PREVIOUS_NATIVE_SCENE_LIMITS, SCENE_COMPATIBILITY, SCENE_COMPILER_LEVEL, SCENE_LIMITS, SCENE_SCHEMA } from "./constants.js";
import { compactCanonicalPathOperands, mapScenePaths } from "./path-canonical.js";
import { serializeTransforms } from "./transforms.js";
import type { PathElement, SceneElement, VectorScene } from "./types.js";

interface PixelSource {
  readonly width: number;
  readonly height: number;
  readonly rgba8: Uint8Array;
}

type ChannelBits = 5 | 6 | 7;
type Color = [number, number, number];
type Sample = { key: number; count: number; sum: Color };
type Bucket = { samples: Sample[]; axis: number; score: number };
export const MAX_TRACE_SOURCE_PIXELS = 4_194_304;
const MAX_TRACE_EDGE = 576;
const NATIVE_TRANSPARENT_EDGE = 1536;
class TraceContourLimitError extends RangeError {}

function traceGrid(source: PixelSource, maxEdge = MAX_TRACE_EDGE) {
  const { width, height, rgba8 } = source;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width * height > MAX_TRACE_SOURCE_PIXELS || rgba8.length !== width * height * 4) {
    throw new RangeError("Raster tracing requires a bounded RGBA8 image.");
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
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
  if (cols === width && rows === height) {
    // On a native grid the cell covers exactly one source pixel.
    const index = (y * width + x) * 4;
    if (rgba8[index + 3] !== 255) throw new RangeError("Raster tracing requires opaque pixels.");
    return [rgba8[index]!, rgba8[index + 1]!, rgba8[index + 2]!];
  }
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

function recordColor({ bits, keys, histogram }: Pick<SampledRaster, "bits" | "keys" | "histogram">, i: number, rgb: Color) {
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

function colorDifference(a: Color, b: Color): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function averagePair(a: Color, b: Color): Color {
  return [
    Math.round((a[0] + b[0]) / 2),
    Math.round((a[1] + b[1]) / 2),
    Math.round((a[2] + b[2]) / 2),
  ];
}

function averageQuad([a, b, c, d]: [Color, Color, Color, Color]): Color {
  return [
    Math.round((a[0] + b[0] + c[0] + d[0]) / 4),
    Math.round((a[1] + b[1] + c[1] + d[1]) / 4),
    Math.round((a[2] + b[2] + c[2] + d[2]) / 4),
  ];
}

function splitAlongEdge(
  [topLeft, topRight, bottomLeft, bottomRight]: [Color, Color, Color, Color],
  errorLimit: number,
): Color[] | undefined {
  // Summed absolute error from each rounded pair average equals the
  // difference between the pair. Test both splits before averaging either.
  const rowError = colorDifference(topLeft, topRight) + colorDifference(bottomLeft, bottomRight);
  const columnError = colorDifference(topLeft, bottomLeft) + colorDifference(topRight, bottomRight);
  if (Math.min(rowError, columnError) > errorLimit) return undefined;
  if (rowError <= columnError) {
    const top = averagePair(topLeft, topRight), bottom = averagePair(bottomLeft, bottomRight);
    return [top, top, bottom, bottom];
  }
  const left = averagePair(topLeft, bottomLeft), right = averagePair(topRight, bottomRight);
  return [left, right, left, right];
}

function sampleAdaptiveRaster(
  source: PixelSource, coarse: { cols: number; rows: number }, edgeThreshold: number,
  subdivision: "span" | "mean-error" | "directional" = "span",
): SampledRaster {
  const cols = coarse.cols * 2, rows = coarse.rows * 2;
  const nativeGrid = cols === source.width && rows === source.height;
  const sampled = makeSamples(cols, rows, subdivision === "directional" ? 7 : 6);
  for (let y = 0; y < coarse.rows; y += 1) {
    for (let x = 0; x < coarse.cols; x += 1) {
      const left = 2 * x, top = 2 * y;
      const subcells: [Color, Color, Color, Color] = [
        sampleCell(source, cols, rows, left, top),
        sampleCell(source, cols, rows, left + 1, top),
        sampleCell(source, cols, rows, left, top + 1),
        sampleCell(source, cols, rows, left + 1, top + 1),
      ];
      // On an exact grid the four subcells already hold every covered pixel.
      const center = subdivision === "span" ? undefined
        : nativeGrid ? averageQuad(subcells) : sampleCell(source, coarse.cols, coarse.rows, x, y);
      const resolveEdge = center === undefined
        ? [0, 1, 2].some((channel) => {
            const values = subcells.map((rgb) => rgb[channel]!);
            return Math.max(...values) - Math.min(...values) >= edgeThreshold;
          })
        : subcells.reduce((error, color) => error + colorDifference(color, center), 0)
          >= edgeThreshold * subcells.length * 3;
      const shared = resolveEdge ? undefined
        : center ?? (nativeGrid ? averageQuad(subcells) : sampleCell(source, coarse.cols, coarse.rows, x, y));
      const pairs = resolveEdge && subdivision === "directional"
        ? splitAlongEdge(subcells, edgeThreshold * subcells.length * 3) : undefined;
      subcells.forEach((color, offset) => {
        const index = (top + (offset >> 1)) * cols + left + (offset & 1);
        recordColor(sampled, index, shared ?? pairs?.[offset] ?? color);
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

type IndexedColor = { index: number; color: Color };

function nearestIndexedColor(rgb: Color, byRed: readonly IndexedColor[]): number {
  let left = 0, right = byRed.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (byRed[middle]!.color[0] < rgb[0]) left = middle + 1;
    else right = middle;
  }

  let best = 0, distance = Infinity;
  for (const step of [-1, 1]) {
    for (let i = step < 0 ? left - 1 : left; i >= 0 && i < byRed.length; i += step) {
      const { index, color } = byRed[i]!;
      const redError = (rgb[0] - color[0]) ** 2;
      // Later centers in this direction cannot beat the current error on red alone.
      if (redError > distance) break;
      const error = redError + (rgb[1] - color[1]) ** 2 + (rgb[2] - color[2]) ** 2;
      // Keep the original scan's first-center tie rule.
      if (error < distance || (error === distance && index < best)) {
        distance = error;
        best = index;
      }
    }
  }
  return best;
}

function medianColor(items: readonly Sample[], fallback: Color): Color {
  if (items.length === 0) return fallback;
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const cutoff = Math.ceil(total / 2);
  return [0, 1, 2].map((axis) => {
    const bins = new Uint32Array(256);
    for (const item of items) {
      bins[Math.round(item.sum[axis]! / item.count)]! += item.count;
    }
    let cumulative = 0;
    for (let i = 0; i < bins.length; i += 1) {
      cumulative += bins[i]!;
      if (cumulative >= cutoff) return i;
    }
    return fallback[axis]!;
  }) as Color;
}

function quantize(samples: readonly Sample[], paletteSize: number, bits: ChannelBits, indexColors = false) {
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
  const baseIndex = 0;
  const points = samples.map((sample) => ({ sample, rgb: average([sample]) }));
  // Use median-cut for deterministic initialization, then assign each
  // occupied bin to its closest color and refine the palette in place.
  for (let pass = 0; pass < 4; pass += 1) {
    const assigned = centers.map((): Sample[] => []);
    const byRed = indexColors
      ? centers.map((color, index) => ({ index, color })).sort((a, b) => a.color[0] - b.color[0])
      : undefined;
    for (const { sample, rgb } of points) {
      const best = byRed === undefined ? nearestColor(rgb, centers) : nearestIndexedColor(rgb, byRed);
      indices[sample.key] = best;
      assigned[best]!.push(sample);
    }
    if (pass < 3) {
      assigned.forEach((items, i) => {
        if (items.length) centers[i] = average(items);
      });
    } else if (indexColors) {
      // Keep the native contour assignments and seam base paint fixed.
      assigned.forEach((items, i) => {
        if (i !== baseIndex) centers[i] = medianColor(items, centers[i]!);
      });
    }
  }
  const colors = centers.map((rgb) =>
    `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}` as HexColor);
  return { indices, colors, centers };
}

function traceContours(
  pixels: Uint16Array, width: number, height: number, count: number, relativePaths: boolean, implicitClose: boolean,
) {
  const stride = width + 1;
  const steps = [1, stride, -1, -stride];
  // Each directed edge belongs to the cell on its right. Store the
  // color plus one so zero can mark both absent and consumed edges.
  const owners = new Uint16Array(4 * stride * (height + 1));
  const edges = Array.from({ length: count }, (): number[] => []);
  function add(boundary: number[], owner: number, edge: number): void {
    owners[edge] = owner;
    boundary.push(edge);
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const color = pixels[i]!;
      if (color === count) continue; // Reserved index for omitted cells.
      const corner = y * stride + x;
      const boundary = edges[color]!;
      const owner = color + 1;
      if (y === 0 || pixels[i - width] !== color) add(boundary, owner, 4 * corner);
      if (x === width - 1 || pixels[i + 1] !== color) add(boundary, owner, 4 * (corner + 1) + 1);
      if (y === height - 1 || pixels[i + width] !== color) add(boundary, owner, 4 * (corner + stride + 1) + 2);
      if (x === 0 || pixels[i - 1] !== color) add(boundary, owner, 4 * (corner + stride) + 3);
    }
  }
  return edges.map((boundary, color) => {
    const owner = color + 1;
    const contours: string[] = [];
    let segments = 0;
    let previousPosition: number | undefined;
    for (const first of boundary) {
      if (owners[first] !== owner) continue;
      const start = Math.floor(first / 4);
      let direction = first % 4, vertex = start;
      let path = `M${vertex % stride} ${Math.floor(vertex / stride)}`;
      // A relative move starts at the previous subpath's actual current point.
      if (relativePaths && previousPosition !== undefined) {
        const dx = vertex % stride - previousPosition % stride;
        const dy = Math.floor(vertex / stride) - Math.floor(previousPosition / stride);
        const move = `m${dx} ${dy}`;
        if (move.length < path.length) path = move;
      }
      let lastCorner = start;
      segments += implicitClose ? 1 : 2; // Move and optional close command.
      do {
        owners[vertex * 4 + direction] = 0;
        vertex += steps[direction]!;
        if (vertex === start) break;
        // Clockwise edges keep the filled region on their right. Prefer a
        // right turn at a diagonal contact so point-touching loops stay apart.
        const right = (direction + 1) % 4, left = (direction + 3) % 4;
        const corner = vertex * 4;
        let next: number;
        if (owners[corner + right] === owner) next = right;
        else if (owners[corner + direction] === owner) next = direction;
        else if (owners[corner + left] === owner) next = left;
        else throw new Error("Raster contour did not close.");
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
      // SVG fill closes subpaths implicitly. Stroked contours need an explicit
      // close so the final edge and join are painted too.
      contours.push(implicitClose ? path : path + "Z");
      previousPosition = implicitClose ? lastCorner : start;
    }
    return { contours, segments };
  });
}

type TracePoint = readonly [number, number];

function polygonCross([ax, ay]: TracePoint, [bx, by]: TracePoint, [x, y]: TracePoint): number {
  return (bx - ax) * (y - ay) - (by - ay) * (x - ax);
}

function readDetailExclusion(input: unknown, width: number, height: number): readonly TracePoint[] {
  if (!Array.isArray(input) || input.length < 3 || input.length > 8) {
    throw new RangeError("Detail exclusion requires three to eight vertices.");
  }
  const vertices = input.map((point): TracePoint => {
    if (!Array.isArray(point) || point.length !== 2 ||
        !Number.isSafeInteger(point[0]) || !Number.isSafeInteger(point[1]) ||
        point[0] < 0 || point[0] > width || point[1] < 0 || point[1] > height) {
      throw new RangeError("Detail exclusion coordinates must be whole source pixels within the artboard.");
    }
    return [point[0], point[1]];
  });
  for (const [index, vertex] of vertices.entries()) {
    const next = (index + 1) % vertices.length;
    if (vertices.some((point, i) => i !== index && i !== next && polygonCross(vertex, vertices[next]!, point) <= 0)) {
      throw new RangeError("Detail exclusion must be a strictly convex clockwise polygon.");
    }
  }
  return vertices;
}

function visitDetailExclusion(vertices: readonly TracePoint[], visit: (x: number, y: number) => void): void {
  const xs = vertices.map(([x]) => x), ys = vertices.map(([, y]) => y);
  let omitted = 0;
  for (let y = Math.min(...ys); y < Math.max(...ys); y++) {
    for (let x = Math.min(...xs); x < Math.max(...xs); x++) {
      if (vertices.every((vertex, i) => polygonCross(vertex, vertices[(i + 1) % vertices.length]!, [x + 0.5, y + 0.5]) >= 0)) {
        visit(x, y);
        omitted++;
      }
    }
  }
  if (omitted === 0) throw new RangeError("Detail exclusion does not cover a cell.");
}

function sampleCoarsePaint(grid: SampledRaster, colorLimit: number) {
  const { colors, indices } = quantize([...grid.histogram.values()], colorLimit, grid.bits);
  const data = Uint16Array.from(grid.keys, (key) => indices[key]!);
  return { grid, data, palette: colors };
}

function sampleExclusionPaint(
  undercoat: ReturnType<typeof sampleCoarsePaint>, cols: number, rows: number, vertices: readonly TracePoint[],
) {
  const { grid, data, palette } = undercoat;
  const patch = new Uint16Array(cols * rows).fill(palette.length);
  const colors = new Set<number>();
  visitDetailExclusion(vertices, (x, y) => {
    const paintX = Math.floor((x + 0.5) * grid.cols / cols);
    const paintY = Math.floor((y + 0.5) * grid.rows / rows);
    const index = data[paintY * grid.cols + paintX]!;
    patch[y * cols + x] = index;
    colors.add(index);
  });
  return { undercoat, cols, rows, patch, colorCount: colors.size };
}

interface TraceSettings {
  paletteSize: number;
  block?: 2 | 4;
  segmentLimit?: number;
  maxSvgBytes?: number;
  authoredElementBudget?: number;
  implicitClose?: boolean;
  fitColors?: boolean;
  excludeDetail?: readonly TracePoint[] | undefined;
  preparedExclusion?: ReturnType<typeof sampleExclusionPaint> | undefined;
  underpaintColors?: number;
  underpaintSource?: SampledRaster;
}

function illustrationScene(source: PixelSource, cols: number, rows: number, elements: SceneElement[]): VectorScene {
  return {
    schema: SCENE_SCHEMA, compatibility: SCENE_COMPATIBILITY, compilerLevel: SCENE_COMPILER_LEVEL,
    profile: "illustration",
    artboard: { width: source.width, height: source.height, viewBox: [0, 0, cols, rows] },
    accessibility: { mode: "labelled", title: "Traced illustration" },
    elements,
  };
}

function fitSourceColors(source: PixelSource, pixels: Uint16Array, colors: readonly HexColor[]): HexColor[] {
  // Each source pixel votes for the fill of its unchanged trace cell.
  const stride = 3 * 256;
  const bins = new Uint32Array(colors.length * stride);
  const counts = new Uint32Array(colors.length);
  for (let i = 0; i < pixels.length; i++) {
    const color = pixels[i]!;
    if (color === 0) continue;
    counts[color]!++;
    for (let channel = 0; channel < 3; channel++) {
      bins[color * stride + channel * 256 + source.rgba8[i * 4 + channel]!]!++;
    }
  }
  return colors.map((color, index) => {
    const count = counts[index]!;
    if (count === 0) return color;
    const rgb = [0, 1, 2].map((channel) => {
      const center = Number.parseInt(color.slice(1 + 2 * channel, 3 + 2 * channel), 16);
      const lowerVote = Math.ceil(count / 2);
      const upperVote = Math.floor(count / 2) + 1;
      let seen = 0;
      let lower = -1;
      for (let value = 0; value < 256; value++) {
        seen += bins[index * stride + channel * 256 + value]!;
        if (lower === -1 && seen >= lowerVote) lower = value;
        if (seen >= upperVote) return Math.max(lower, Math.min(value, center));
      }
      return center;
    });
    return `#${rgb.map(value => value.toString(16).padStart(2, "0")).join("")}` as HexColor;
  });
}

function traceSampledRaster(
  source: PixelSource,
  sampled: SampledRaster,
  { paletteSize, block = 2, segmentLimit = Infinity, maxSvgBytes = Infinity, authoredElementBudget = Infinity,
    underpaintColors, underpaintSource = sampled,
    implicitClose = false, excludeDetail, preparedExclusion, fitColors = false }: TraceSettings,
  palette = quantize([...sampled.histogram.values()], paletteSize, sampled.bits),
): VectorScene {
  const { cols, rows, keys } = sampled;
  if (preparedExclusion && (preparedExclusion.cols !== cols || preparedExclusion.rows !== rows)) {
    throw new RangeError("Detail exclusion requires prepared paint matching the native sample dimensions.");
  }
  const { indices, colors: originalColors, centers } = palette;
  const pixels = Uint16Array.from(keys, (key) => indices[key]!);
  const colors = fitColors ? fitSourceColors(source, pixels, originalColors) : originalColors;
  const elements: PathElement[] = [];
  let coarsePaint: ReturnType<typeof sampleCoarsePaint> | undefined;
  let totalSegments = 0;
  let svgBytes = 1024; // Reserve the SVG header, accessibility title and base path.
  let svgLimit = maxSvgBytes;

  const base = { type: "solid", color: colors[0]! } as const;

  function addLayer(
    data: Uint16Array, width: number, height: number, name: string, scale: number,
    palette: readonly HexColor[] = colors, scaleY = scale,
  ) {
    const transform = scale === 1 && scaleY === 1 ? undefined : [
      { type: "scale" as const, x: scale, ...(scaleY === scale ? {} : { y: scaleY }) },
    ];
    const pathOverhead = 128 + (serializeTransforms(transform)?.length ?? 0);
    const shapes = traceContours(data, width, height, palette.length, underpaintColors !== undefined, implicitClose);
    shapes.forEach(({ contours, segments }, index) => {
      totalSegments += segments;
      if (totalSegments > segmentLimit) throw new TraceContourLimitError("Raster contours exceed the scene path segment limit.");
      const fill = { type: "solid", color: palette[index]! } as const;
      const d = contours.join("");
      if (d.length > SCENE_LIMITS.maxPathBytes) throw new TraceContourLimitError("Raster contours exceed the per-color path limit.");
      if (d) {
        // ASCII path data gains a separator before each command and after each
        // non-close command in the spaced SVG. The remaining reserve covers the
        // short generated ID, tag, indentation and fixed paint syntax.
        svgBytes += d.length + 2 * segments - (implicitClose ? 0 : contours.length) + pathOverhead;
        if (svgBytes > svgLimit) throw new TraceContourLimitError("Raster contours exceed the SVG byte budget.");
        if (elements.length >= authoredElementBudget) {
          throw new TraceContourLimitError("Raster contours exceed the authored element budget.");
        }
        elements.push({
          type: "path", id: `trace-${name}-${index}`, d,
          presentation: { fill },
          ...(transform === undefined ? {} : { transform }),
        });
      }
    });
  }
  // Similar underpainting remains visible through fractional-pixel seams.
  if (cols > 4 && rows > 4) {
    totalSegments += 5; // One move, three sides, and close.
    elements.push({ type: "path", id: "trace-base", d: `M0 0H${cols}V${rows}H0Z`, presentation: { fill: base } });
    if (underpaintColors !== undefined) {
      coarsePaint = preparedExclusion?.undercoat ?? sampleCoarsePaint(underpaintSource, underpaintColors);
      const { grid, data, palette } = coarsePaint;
      addLayer(data, grid.cols, grid.rows, "undercoat",
        cols / grid.cols, palette, rows / grid.rows);
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
  const scene = illustrationScene(source, cols, rows, elements);
  if (excludeDetail) {
    if (coarsePaint === undefined) throw new RangeError("Detail exclusion requires an underpaint.");
    if (Buffer.byteLength(JSON.stringify(scene), "utf8") > SCENE_LIMITS.maxInputBytes) {
      throw new TraceContourLimitError("Native trace exceeds the editable scene size limit.");
    }
    const { patch } = preparedExclusion ?? sampleExclusionPaint(coarsePaint, cols, rows, excludeDetail);
    // Keeping the original compound paths intact confines browser paint to
    // the selected region, even when an affected detail color spans the page.
    svgLimit = RASTER_MAX_SVG_BYTES;
    try {
      addLayer(patch, cols, rows, "edit-underpaint", 1, coarsePaint.palette);
      if (Buffer.byteLength(JSON.stringify(scene), "utf8") <= SCENE_LIMITS.maxInputBytes) return scene;
    } catch (error) {
      if (!(error instanceof TraceContourLimitError)) throw error;
    }
    throw new RangeError("Detail exclusion exceeds the selected native trace's limits.");
  }
  return scene;
}

function sampleAlphaCell(source: PixelSource, cols: number, rows: number, x: number, y: number) {
  const { width, height, rgba8 } = source;
  const left = x * width, right = (x + 1) * width;
  const top = y * height, bottom = (y + 1) * height;
  const sum: Color = [0, 0, 0];
  let coverage = 0;
  // Accumulate premultiplied color so hidden RGB never bleeds into downsampled edges.
  for (let sy = Math.floor(top / rows); sy < Math.ceil(bottom / rows); sy += 1) {
    const overlapY = Math.min(bottom, (sy + 1) * rows) - Math.max(top, sy * rows);
    for (let sx = Math.floor(left / cols); sx < Math.ceil(right / cols); sx += 1) {
      const overlapX = Math.min(right, (sx + 1) * cols) - Math.max(left, sx * cols);
      const offset = (sy * width + sx) * 4;
      const weight = overlapX * overlapY * rgba8[offset + 3]!;
      coverage += weight;
      for (let c = 0; c < 3; c++) sum[c]! += rgba8[offset + c]! * weight;
    }
  }
  return {
    alpha: Math.round(coverage / (width * height)),
    rgb: sum.map(value => coverage === 0 ? 0 : Math.round(value / coverage)) as Color,
  };
}

function interiorUnderpaint(source: PixelSource, coverage: Uint8Array, cols: number, rows: number, cell: number, inset: number, maxColors = 64, nearOpaqueBand = 16) {
  const width = Math.ceil(cols / cell), height = Math.ceil(rows / cell);
  const samples = makeSamples(width, height, 6);
  const keep = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Keep at least the stroke radius between the fill and any lower-alpha pixels or artboard edge.
      const left = Math.floor(x * cols / width) - inset, right = Math.ceil((x + 1) * cols / width) + inset;
      const top = Math.floor(y * rows / height) - inset, bottom = Math.ceil((y + 1) * rows / height) + inset;
      if (left < 0 || top < 0 || right > cols || bottom > rows) continue;
      let eligible = true;
      for (let row = top; row < bottom && eligible; row++) {
        for (let col = left; col < right; col++) {
          if (coverage[row * cols + col] !== nearOpaqueBand) {
            eligible = false;
            break;
          }
        }
      }
      if (!eligible) continue;
      const i = y * width + x;
      keep[i] = 1;
      recordColor(samples, i, sampleAlphaCell(source, width, height, x, y).rgb);
    }
  }
  if (samples.histogram.size === 0) return undefined;
  const { colors, indices } = quantize([...samples.histogram.values()], maxColors, samples.bits);
  const pixels = Uint16Array.from(samples.keys, (key, i) => keep[i] ? indices[key]! : colors.length);
  return { width, height, pixels, palette: colors.map(color => ({ color, fillOpacity: 1 })) };
}

function traceTransparentRaster(
  source: PixelSource, maxEdge: number, paletteBudget: number, authoredElementBudget: number,
  fineAlpha = false, attemptedPalettes?: Set<number>,
): VectorScene {
  const { cols, rows } = traceGrid(source, maxEdge);
  const nativeLarge = maxEdge === NATIVE_TRANSPARENT_EDGE && Math.max(cols, rows) > MAX_TRACE_EDGE;
  const nearOpaqueBand = fineAlpha ? 24 : 16;
  const alphas = new Uint8Array(cols * rows);
  const colorKeys = new Uint32Array(cols * rows);
  const bits = 6 as const;
  const bands = Array.from({ length: nearOpaqueBand + 1 }, () => ({
    bits, keys: colorKeys, histogram: new Map<number, Sample>(), count: 0, alphaSum: 0,
  }));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const index = y * cols + x;
      const { alpha, rgb } = sampleAlphaCell(source, cols, rows, x, y);
      if (fineAlpha && alpha < 8) continue;
      const band = fineAlpha
        ? alpha < 120 ? Math.round(alpha / 8) : Math.round(alpha / 16) + 8
        : Math.round(alpha / 16);
      if (band === 0) continue;
      const bucket = bands[band]!;
      alphas[index] = band;
      bucket.count++;
      bucket.alphaSum += alpha;
      recordColor(bucket, index, rgb);
    }
  }
  // Determine eligibility independently for both grids before allocating detail colors.
  const inset = nativeLarge ? 1 : 2;
  const preparedPaint = fineAlpha ? interiorUnderpaint(source, alphas, cols, rows, 4, inset, 64, nearOpaqueBand) : undefined;
  const preparedFine = fineAlpha && nativeLarge
    ? interiorUnderpaint(source, alphas, cols, rows, 3, inset, 47, nearOpaqueBand) : undefined;
  const palette: { color: HexColor; fillOpacity: number }[] = [];
  const mappings = bands.map(({ count, alphaSum, histogram }, band) => {
    if (count === 0) return undefined;
    let maxColors = band === nearOpaqueBand ? paletteBudget : fineAlpha && band <= 15 ? 14 : 32;
    if (fineAlpha && band === nearOpaqueBand) {
      // Native-large reserves 64 coarse paints, 47 fine paints and the opacity group.
      // Reduced attempts must still leave room for eligible coarse paint and its group.
      const paintReserve = nativeLarge ? 64 + 47 + 1 : preparedPaint ? 64 + 1 : 0;
      maxColors = Math.min(maxColors, authoredElementBudget - palette.length - paintReserve);
      if (maxColors <= 0 || attemptedPalettes?.has(maxColors)) {
        throw new TraceContourLimitError("Transparent trace has no new palette within the paint reservation.");
      }
      attemptedPalettes?.add(maxColors);
    }
    const { colors, indices } = quantize([...histogram.values()], maxColors, bits);
    const offset = palette.length;
    palette.push(...colors.map(color => ({ color, fillOpacity: alphaSum / count / 255 })));
    return { indices, offset };
  });
  const pixels = Uint16Array.from(alphas, (band, i) => {
    const mapping = mappings[band];
    return mapping === undefined ? palette.length : mapping.offset + mapping.indices[colorKeys[i]!]!;
  });
  function contoursForLayer(
    name: string, data: Uint16Array, width: number, height: number,
    paints: typeof palette, transform?: PathElement["transform"], underpaintStroke?: number,
  ) {
    const elements: PathElement[] = [];
    let bytes = 0, segments = 0;
    const overhead = 192 + (serializeTransforms(transform)?.length ?? 0);
    const shapes = traceContours(data, width, height, paints.length, true, underpaintStroke === undefined);
    for (const [index, shape] of shapes.entries()) {
      if (shape.contours.length === 0) continue;
      const d = shape.contours.join("");
      if (d.length > SCENE_LIMITS.maxPathBytes) {
        throw new TraceContourLimitError("Transparent trace exceeds the per-color path limit.");
      }
      bytes += d.length + 2 * shape.segments + overhead;
      segments += shape.segments;
      const { color, fillOpacity } = paints[index]!;
      const fill = { type: "solid" as const, color };
      elements.push({ type: "path", id: `trace-${name}-${index}`, d, presentation: {
        fill, ...(fillOpacity === 1 ? {} : { fillOpacity }),
        ...(underpaintStroke === undefined ? {} : { stroke: fill, strokeWidth: underpaintStroke, strokeLinejoin: "bevel" as const }),
      }, ...(transform === undefined ? {} : { transform }) });
    }
    return { bytes, segments, elements };
  }
  function sceneWithinBudget(
    layers: ReturnType<typeof contoursForLayer>[], groupedElements?: SceneElement[],
  ) {
    const groupOverhead = groupedElements === undefined ? 0 : 192;
    const bytes = 1024 + groupOverhead + layers.reduce((total, layer) => total + layer.bytes, 0);
    const segments = layers.reduce((total, layer) => total + layer.segments, 0);
    const authoredCount = layers.reduce((total, layer) => total + layer.elements.length, 0) +
      (groupedElements === undefined ? 0 : 1);
    if (bytes > RASTER_MAX_SVG_BYTES || segments > ILLUSTRATION_SCENE_LIMITS.maxAggregatePathSegments ||
        authoredCount > authoredElementBudget) {
      throw new TraceContourLimitError("Transparent trace exceeds the SVG contour budget.");
    }
    const elements = groupedElements ?? layers.flatMap(layer => layer.elements);
    const scene = illustrationScene(source, cols, rows, elements);
    if (Buffer.byteLength(JSON.stringify(scene)) > SCENE_LIMITS.maxInputBytes) {
      throw new TraceContourLimitError("Transparent trace exceeds the editable scene budget.");
    }
    return scene;
  }
  const detail = contoursForLayer("alpha", pixels, cols, rows, palette);
  // Both bevel strokes extend at most one trace cell after scaling.
  const paint = fineAlpha ? preparedPaint : interiorUnderpaint(source, alphas, cols, rows, 4, inset);
  const nearOpaque = mappings[nearOpaqueBand];
  if ((paint || preparedFine) && nearOpaque) {
    try {
      const paints: ReturnType<typeof contoursForLayer>[] = [];
      if (paint) {
        const x = cols / paint.width, y = rows / paint.height;
        paints.push(contoursForLayer("alpha-underpaint", paint.pixels, paint.width, paint.height, paint.palette,
          [{ type: "scale", x, ...(x === y ? {} : { y }) }], 0.5));
      }
      const { fillOpacity } = palette[nearOpaque.offset]!;
      const lowerBands: PathElement[] = [];
      const nearOpaquePaths: PathElement[] = [];
      for (const path of detail.elements) {
        const { fillOpacity: opacity, ...presentation } = path.presentation ?? {};
        if (opacity === fillOpacity) nearOpaquePaths.push({ ...path, presentation });
        else lowerBands.push(path);
      }
      function compose(paints: ReturnType<typeof contoursForLayer>[]) {
        if (fillOpacity === 1) return sceneWithinBudget([...paints, detail]);
        // The detail and both paint grids share one opacity application.
        return sceneWithinBudget([...paints, detail], [
          ...lowerBands, {
            type: "group", id: "trace-near-opaque", presentation: { opacity: fillOpacity },
            children: [...paints.flatMap(layer => layer.elements), ...nearOpaquePaths],
          },
        ]);
      }

      if (nativeLarge) {
        try {
          // Reserve an element for the near-opaque group before selecting fine paints.
          const spare = authoredElementBudget - detail.elements.length - (paints[0]?.elements.length ?? 0) - 1;
          const fine = fineAlpha ? preparedFine
            : spare > 0 ? interiorUnderpaint(source, alphas, cols, rows, 3, inset, Math.min(64, spare)) : undefined;
          if (fine) {
            const sx = cols / fine.width, sy = rows / fine.height;
            const fineLayer = contoursForLayer("alpha-fine-underpaint", fine.pixels, fine.width, fine.height, fine.palette,
              [{ type: "scale", x: sx, ...(sx === sy ? {} : { y: sy }) }], 2 / 3);
            return compose([...paints, fineLayer]);
          }
        } catch (error) {
          if (fineAlpha || !(error instanceof TraceContourLimitError)) throw error;
        }
      }
      return compose(paints);
    } catch (error) {
      if (fineAlpha || !(error instanceof TraceContourLimitError)) throw error;
    }
  }
  return sceneWithinBudget([detail]);
}

const HIGH_DETAIL_SVG_BUDGET = 12_000_000;
const DENSE_PALETTE_COLOR_LIMIT = 1856;
const NATIVE_UNDERPAINT_COLORS = 96;

/** Trace sRGB illustrations as editable contours. Alpha preservation is opt-in. */
export function traceRasterScene(
  source: PixelSource,
  options: {
    readonly highDetail?: boolean;
    readonly nativeDetail?: boolean;
    readonly densePalette?: boolean;
    readonly fitSourceColors?: boolean;
    readonly excludeDetail?: unknown;
    readonly preserveAlpha?: boolean;
    readonly fineAlpha?: boolean;
    readonly reserveElements?: number;
  } = {},
): VectorScene {
  const grid = traceGrid(source);
  if (options.fineAlpha !== undefined && typeof options.fineAlpha !== "boolean") {
    throw new RangeError("Fine alpha must be a boolean.");
  }
  if (options.fineAlpha === true && (options.nativeDetail !== true || options.preserveAlpha !== true)) {
    throw new RangeError("Fine alpha requires native detail and alpha preservation.");
  }
  if (options.fitSourceColors && (!options.nativeDetail || options.preserveAlpha)) {
    throw new RangeError("Source color fitting requires an opaque native-detail trace.");
  }
  if (options.densePalette && (!options.nativeDetail || options.preserveAlpha)) {
    throw new RangeError("A dense palette requires an opaque native-detail trace.");
  }
  if (options.preserveAlpha && options.excludeDetail !== undefined) {
    throw new RangeError("Transparent tracing does not support detail exclusion.");
  }
  const transparent = options.preserveAlpha && source.rgba8.some((value, i) => (i & 3) === 3 && value !== 255);
  const reserve = options.reserveElements ?? 0;
  if (options.reserveElements !== undefined && ((!transparent && !options.densePalette) || !Number.isInteger(reserve)
      || reserve < 1 || reserve >= SCENE_LIMITS.maxAuthoredElements)) {
    throw new RangeError("Element reservation requires transparent tracing or a dense palette and a positive count below the scene limit.");
  }
  const authoredElementBudget = SCENE_LIMITS.maxAuthoredElements - reserve;
  if (transparent) {
    const presets = options.nativeDetail ? [NATIVE_TRANSPARENT_EDGE, 1152, 768, 576] : options.highDetail === false ? [576] : [1152, 768, 576];
    for (const edge of presets) {
      // Retry the established palette at the same resolution before accepting a coarser grid.
      const palettePresets = edge === NATIVE_TRANSPARENT_EDGE ? [1408, 1152] : [1152];
      const paletteBudgets = new Set(palettePresets.flatMap(colors => [colors, Math.max(1, colors - reserve)]));
      const attemptedPalettes = options.fineAlpha ? new Set<number>() : undefined;
      for (const colors of paletteBudgets) {
        try {
          return traceTransparentRaster(source, edge, colors, authoredElementBudget, options.fineAlpha, attemptedPalettes);
        } catch (error) {
          if (!(error instanceof TraceContourLimitError)) throw error;
        }
      }
    }
    throw new RangeError("Transparent raster contours exceed the scene limits.");
  }
  const segmentLimit = SCENE_LIMITS.maxAggregatePathSegments;
  const excludeDetail = options.excludeDetail === undefined ? undefined : readDetailExclusion(options.excludeDetail, source.width, source.height);
  if (excludeDetail && !options.nativeDetail) throw new RangeError("Detail exclusion requires native detail.");
  if (options.nativeDetail) {
    // Leave one element for the base and one per underpaint color.
    const defaultDenseColors = Math.min(DENSE_PALETTE_COLOR_LIMIT, authoredElementBudget - NATIVE_UNDERPAINT_COLORS - 1);
    if (options.densePalette && !excludeDetail && defaultDenseColors < 1) {
      throw new RangeError("The element reservation leaves no room for native detail.");
    }
    const nativeGrid = traceGrid(source, 768);
    if (options.fitSourceColors && (nativeGrid.cols * 2 !== source.width || nativeGrid.rows * 2 !== source.height)) {
      throw new RangeError("Source color fitting requires a native grid matching the source pixels.");
    }
    if ((nativeGrid.cols > grid.cols || nativeGrid.rows > grid.rows)
        && nativeGrid.cols * 2 <= source.width && nativeGrid.rows * 2 <= source.height
        && nativeGrid.cols > 4 && nativeGrid.rows > 4) {
      if (excludeDetail && (nativeGrid.cols * 2 !== source.width || nativeGrid.rows * 2 !== source.height)) {
        throw new RangeError("Detail exclusion requires a native grid matching the source pixels.");
      }
      const underpaintSource = sampleRaster(source, 6, {
        cols: Math.ceil(nativeGrid.cols / 2), rows: Math.ceil(nativeGrid.rows / 2),
      });
      // Dense tracing only runs the directional preset below, with this source
      // and color limit. Any future dense fallback must prepare its own paint.
      const preparedExclusion = options.densePalette && excludeDetail
        ? sampleExclusionPaint(sampleCoarsePaint(underpaintSource, NATIVE_UNDERPAINT_COLORS),
          nativeGrid.cols * 2, nativeGrid.rows * 2, excludeDetail)
        : undefined;
      // The edit underpaint emits one authored path for each color present inside the polygon.
      const denseColors = preparedExclusion
        ? Math.min(DENSE_PALETTE_COLOR_LIMIT, authoredElementBudget - 1
          - preparedExclusion.undercoat.palette.length - preparedExclusion.colorCount)
        : defaultDenseColors;
      if (preparedExclusion && denseColors < 1) {
        throw new RangeError("The element reservation leaves no room for native detail.");
      }
      for (const { edgeThreshold, subdivision, ...traceSettings } of [
        { edgeThreshold: 2.625, subdivision: "directional" as const, paletteSize: options.densePalette ? denseColors : 1664, underpaintColors: NATIVE_UNDERPAINT_COLORS, implicitClose: true,
          segmentLimit: ILLUSTRATION_SCENE_LIMITS.maxAggregatePathSegments, maxSvgBytes: RASTER_MAX_SVG_BYTES },
        { edgeThreshold: 4, subdivision: "mean-error" as const, paletteSize: 1536, underpaintColors: 96, implicitClose: true,
          segmentLimit: ILLUSTRATION_SCENE_LIMITS.maxAggregatePathSegments, maxSvgBytes: RASTER_MAX_SVG_BYTES },
        { edgeThreshold: 5.5, subdivision: "mean-error" as const, paletteSize: 1152, underpaintColors: 96, implicitClose: true,
          segmentLimit: ILLUSTRATION_SCENE_LIMITS.maxAggregatePathSegments, maxSvgBytes: RASTER_MAX_SVG_BYTES },
        { edgeThreshold: 6.75, subdivision: "mean-error" as const, paletteSize: 1152, underpaintColors: 96,
          segmentLimit: ILLUSTRATION_SCENE_LIMITS.maxAggregatePathSegments, maxSvgBytes: RASTER_MAX_SVG_BYTES },
        { edgeThreshold: 24, paletteSize: 1024, underpaintColors: 96,
          segmentLimit: ILLUSTRATION_SCENE_LIMITS.maxAggregatePathSegments },
        { edgeThreshold: 36, paletteSize: 640, underpaintColors: 96,
          segmentLimit: PREVIOUS_NATIVE_SCENE_LIMITS.maxAggregatePathSegments },
      ]) {
        if ((options.densePalette || options.fitSourceColors) && subdivision !== "directional") break;
        try {
          const sampled = sampleAdaptiveRaster(source, nativeGrid, edgeThreshold, subdivision);
          // Keep palette search within the six-bit pass's maximum occupied-bin count.
          if (subdivision === "directional" && sampled.histogram.size > 2 ** 18) continue;
          const palette = quantize([...sampled.histogram.values()], traceSettings.paletteSize, sampled.bits, subdivision === "directional");
          const scene = traceSampledRaster(source, sampled, {
            ...traceSettings, underpaintSource, excludeDetail, preparedExclusion, fitColors: options.fitSourceColors === true,
            ...(options.densePalette ? { authoredElementBudget } : {}),
          }, palette);
          if (excludeDetail) return scene;
          const bytes = Buffer.byteLength(JSON.stringify(scene), "utf8");
          if (bytes <= SCENE_LIMITS.maxInputBytes) return scene;
          if (bytes <= SCENE_LIMITS.maxCanonicalPathsBytes) {
            // Generated contour coordinates are integers. A minus sign already
            // separates the next operand, so the preceding space is optional.
            const compact = mapScenePaths(scene, compactCanonicalPathOperands);
            if (Buffer.byteLength(JSON.stringify(compact), "utf8") <= SCENE_LIMITS.maxInputBytes) return compact;
          }
        } catch (error) {
          if (!(error instanceof TraceContourLimitError)) throw error;
        }
      }
    }
  }
  if (options.fitSourceColors) throw new RangeError("Source color fitting requires a supported native trace within scene limits.");
  if (options.densePalette) throw new RangeError("A dense palette requires a supported native trace within scene limits.");
  if (excludeDetail) throw new RangeError("Detail exclusion requires a supported native trace.");
  if ((options.highDetail !== false || options.nativeDetail) && grid.cols * 2 <= source.width && grid.rows * 2 <= source.height
      && grid.cols > 4 && grid.rows > 4) {
    try {
      const sampled = sampleAdaptiveRaster(source, grid, 2);
      return traceSampledRaster(source, sampled, {
        paletteSize: 1152, underpaintColors: 96, underpaintSource: sampleRaster(source, 6, grid),
        segmentLimit: ILLUSTRATION_SCENE_LIMITS.maxAggregatePathSegments, maxSvgBytes: HIGH_DETAIL_SVG_BUDGET,
      });
    } catch (error) {
      if (!(error instanceof TraceContourLimitError)) throw error;
    }
    const underpaintSource = sampleRaster(source, 6, { cols: Math.ceil(grid.cols / 2), rows: Math.ceil(grid.rows / 2) });
    for (const settings of [
      { edgeThreshold: 24, paletteSize: 576, underpaintColors: 96, segmentLimit: HIGH_DETAIL_SCENE_LIMITS.maxAggregatePathSegments },
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
