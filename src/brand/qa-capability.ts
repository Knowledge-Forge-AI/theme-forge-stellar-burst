import { computeSha256, type Sha256Digest } from "../digests.js";
import {
  BRAND_QA_MAX_AGGREGATE_RGBA_BYTES,
  BRAND_QA_MAX_DIMENSION,
  BRAND_QA_MAX_PIXELS_PER_EVALUATION,
  type BrandQaBackground,
} from "./qa-schema.js";

export interface BrandQaRendererDescriptor {
  readonly id: string;
  readonly version: string;
  readonly qualificationId: string;
  readonly platformClaim: string;
}

export interface BrandQaResolvedRenderConfiguration {
  readonly fit: "contain";
  readonly colorSpace: "srgb";
  readonly alpha: "straight";
}

export interface BrandQaRenderInput {
  readonly canonicalSvgBytes: Uint8Array;
  readonly svgDigest: Sha256Digest;
  readonly width: number;
  readonly height: number;
  readonly background: BrandQaBackground;
  readonly backgroundRgba: readonly [number, number, number, number] | null;
  readonly configuration: BrandQaResolvedRenderConfiguration;
}

export interface BrandQaDecodeInput {
  readonly pngBytes: Uint8Array;
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  readonly configuration: BrandQaResolvedRenderConfiguration;
}

export interface BrandQaNormalizedRaster {
  readonly width: number;
  readonly height: number;
  readonly rgba8: Uint8Array;
  readonly pngBytes?: Uint8Array;
}

export interface BrandQaRendererCapability {
  readonly descriptor: BrandQaRendererDescriptor;
  renderSvg(input: BrandQaRenderInput): BrandQaNormalizedRaster | Promise<BrandQaNormalizedRaster>;
  decodePng(input: BrandQaDecodeInput): BrandQaNormalizedRaster | Promise<BrandQaNormalizedRaster>;
}

export interface BrandQaBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface BrandQaRasterMeasurements {
  readonly bounds: BrandQaBounds | null;
  readonly visiblePixels: number;
  readonly topPadding: number;
  readonly rightPadding: number;
  readonly bottomPadding: number;
  readonly leftPadding: number;
}

export interface BrandQaRasterDifference {
  readonly changedPixels: number;
  readonly maximumChannelDelta: number;
  readonly changedBounds: BrandQaBounds | null;
  readonly beforeDecodedPixelDigest: Sha256Digest;
  readonly afterDecodedPixelDigest: Sha256Digest;
  readonly beforePngDigest?: Sha256Digest;
  readonly afterPngDigest?: Sha256Digest;
}

export interface BrandQaRasterBudget {
  decodedRgbaBytes: number;
}

export const BRAND_QA_RENDER_CONFIGURATION: BrandQaResolvedRenderConfiguration = Object.freeze({
  fit: "contain",
  colorSpace: "srgb",
  alpha: "straight",
});

const BRAND_QA_MAX_PNG_BYTES = 32 * 1_048_576;

function validateRequestedRaster(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > BRAND_QA_MAX_DIMENSION || height > BRAND_QA_MAX_DIMENSION || width * height > BRAND_QA_MAX_PIXELS_PER_EVALUATION) throw new Error("Requested raster dimensions exceed the visual QA limits.");
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or extra fields.`);
  }
}

function boundedText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be nonempty, control-free UTF-8 text of at most 256 bytes.`);
  }
}

export function validateBrandQaRendererDescriptor(
  descriptor: BrandQaRendererDescriptor,
  expected?: Partial<Pick<BrandQaRendererDescriptor, "id" | "version" | "platformClaim">>,
): BrandQaRendererDescriptor {
  if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) throw new Error("Renderer descriptor must be an object.");
  exactKeys(descriptor, ["id", "version", "qualificationId", "platformClaim"], "Renderer descriptor");
  boundedText(descriptor.id, "Renderer id");
  boundedText(descriptor.version, "Renderer version");
  boundedText(descriptor.qualificationId, "Renderer qualification id");
  boundedText(descriptor.platformClaim, "Renderer platform claim");
  if (expected?.id !== undefined && descriptor.id !== expected.id) throw new Error("Renderer id mismatch.");
  if (expected?.version !== undefined && descriptor.version !== expected.version) throw new Error("Renderer version mismatch.");
  if (expected?.platformClaim !== undefined && descriptor.platformClaim !== expected.platformClaim) throw new Error("Renderer platform claim mismatch.");
  return Object.freeze({ ...descriptor });
}

export function parseBrandQaBackgroundRgba(background: BrandQaBackground): readonly [number, number, number, number] | null {
  if (background === "transparent") return null;
  if (background.startsWith("token:")) throw new Error("Token background must be resolved by brand token authority before rendering.");
  return Object.freeze([
    Number.parseInt(background.slice(1, 3), 16),
    Number.parseInt(background.slice(3, 5), 16),
    Number.parseInt(background.slice(5, 7), 16),
    Number.parseInt(background.slice(7, 9), 16),
  ]);
}

export function validateBrandQaNormalizedRaster(
  raster: BrandQaNormalizedRaster,
  expectedWidth: number,
  expectedHeight: number,
  budget?: BrandQaRasterBudget,
): BrandQaNormalizedRaster {
  if (typeof raster !== "object" || raster === null || Array.isArray(raster)) throw new Error("Renderer result must be an object.");
  const allowedKeys = raster.pngBytes === undefined ? ["width", "height", "rgba8"] : ["width", "height", "rgba8", "pngBytes"];
  exactKeys(raster, allowedKeys, "Renderer result");
  if (!Number.isSafeInteger(raster.width) || !Number.isSafeInteger(raster.height) || raster.width < 1 || raster.height < 1 || raster.width > BRAND_QA_MAX_DIMENSION || raster.height > BRAND_QA_MAX_DIMENSION) throw new Error("Renderer result dimensions are invalid.");
  if (raster.width !== expectedWidth || raster.height !== expectedHeight) throw new Error("Renderer result dimensions do not match the request.");
  const pixels = raster.width * raster.height;
  if (!Number.isSafeInteger(pixels) || pixels > BRAND_QA_MAX_PIXELS_PER_EVALUATION) throw new Error("Renderer result exceeds the pixel limit.");
  if (!(raster.rgba8 instanceof Uint8Array) || raster.rgba8.byteLength !== pixels * 4) throw new Error("Renderer RGBA length must equal width * height * 4.");
  if (raster.pngBytes !== undefined && (!(raster.pngBytes instanceof Uint8Array) || raster.pngBytes.byteLength > BRAND_QA_MAX_PNG_BYTES)) throw new Error("Renderer PNG bytes must be a Uint8Array of at most 32 MiB.");
  if (budget !== undefined) {
    const next = budget.decodedRgbaBytes + raster.rgba8.byteLength;
    if (!Number.isSafeInteger(next) || next > BRAND_QA_MAX_AGGREGATE_RGBA_BYTES) throw new Error("Renderer run exceeds the aggregate decoded RGBA limit.");
    budget.decodedRgbaBytes = next;
  }
  return Object.freeze({ width: raster.width, height: raster.height, rgba8: new Uint8Array(raster.rgba8), ...(raster.pngBytes === undefined ? {} : { pngBytes: new Uint8Array(raster.pngBytes) }) });
}

export async function renderBrandQaRaster(
  capability: BrandQaRendererCapability,
  input: BrandQaRenderInput,
  budget?: BrandQaRasterBudget,
): Promise<BrandQaNormalizedRaster> {
  validateRequestedRaster(input.width, input.height);
  validateBrandQaRendererDescriptor(capability.descriptor);
  const request: BrandQaRenderInput = Object.freeze({ ...input, canonicalSvgBytes: new Uint8Array(input.canonicalSvgBytes), backgroundRgba: input.backgroundRgba === null ? null : Object.freeze([...input.backgroundRgba] as [number, number, number, number]), configuration: BRAND_QA_RENDER_CONFIGURATION });
  return validateBrandQaNormalizedRaster(await capability.renderSvg(request), input.width, input.height, budget);
}

export async function decodeBrandQaBaseline(
  capability: BrandQaRendererCapability,
  pngBytes: Uint8Array,
  width: number,
  height: number,
  budget?: BrandQaRasterBudget,
): Promise<BrandQaNormalizedRaster> {
  validateRequestedRaster(width, height);
  if (!(pngBytes instanceof Uint8Array) || pngBytes.byteLength > BRAND_QA_MAX_PNG_BYTES) throw new Error("Baseline PNG bytes must be a Uint8Array of at most 32 MiB.");
  validateBrandQaRendererDescriptor(capability.descriptor);
  const input: BrandQaDecodeInput = Object.freeze({ pngBytes: new Uint8Array(pngBytes), expectedWidth: width, expectedHeight: height, configuration: BRAND_QA_RENDER_CONFIGURATION });
  return validateBrandQaNormalizedRaster(await capability.decodePng(input), width, height, budget);
}

function visibleAt(rgba: Uint8Array, offset: number, background: readonly [number, number, number, number] | null, alphaThreshold: number, alphaOnly: boolean): boolean {
  const alpha = rgba[offset + 3]!;
  if (alpha <= alphaThreshold) return false;
  if (alphaOnly || background === null) return true;
  return rgba[offset] !== background[0] || rgba[offset + 1] !== background[1] || rgba[offset + 2] !== background[2] || alpha !== background[3];
}

export function measureBrandQaRaster(
  raster: BrandQaNormalizedRaster,
  background: readonly [number, number, number, number] | null,
  alphaThreshold = 0,
  alphaOnly = false,
): BrandQaRasterMeasurements {
  let left = raster.width;
  let top = raster.height;
  let right = -1;
  let bottom = -1;
  let visiblePixels = 0;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const offset = (y * raster.width + x) * 4;
      if (!visibleAt(raster.rgba8, offset, background, alphaThreshold, alphaOnly)) continue;
      visiblePixels++;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  const bounds = visiblePixels === 0 ? null : Object.freeze({ left, top, right, bottom });
  return Object.freeze({
    bounds,
    visiblePixels,
    topPadding: bounds === null ? raster.height : bounds.top,
    rightPadding: bounds === null ? raster.width : raster.width - 1 - bounds.right,
    bottomPadding: bounds === null ? raster.height : raster.height - 1 - bounds.bottom,
    leftPadding: bounds === null ? raster.width : bounds.left,
  });
}

export function countBrandQaForbiddenEdgePixels(
  raster: BrandQaNormalizedRaster,
  background: readonly [number, number, number, number] | null,
  forbiddenEdgePixels: number,
): number {
  let count = 0;
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    if (x >= forbiddenEdgePixels && x < raster.width - forbiddenEdgePixels && y >= forbiddenEdgePixels && y < raster.height - forbiddenEdgePixels) continue;
    if (visibleAt(raster.rgba8, (y * raster.width + x) * 4, background, 0, false)) count++;
  }
  return count;
}

export function compareBrandQaRasters(before: BrandQaNormalizedRaster, after: BrandQaNormalizedRaster): BrandQaRasterDifference {
  if (before.width !== after.width || before.height !== after.height || before.rgba8.byteLength !== after.rgba8.byteLength) throw new Error("Raster dimensions must match for comparison.");
  let changedPixels = 0;
  let maximumChannelDelta = 0;
  let left = before.width, top = before.height, right = -1, bottom = -1;
  for (let pixel = 0; pixel < before.width * before.height; pixel++) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const offset = pixel * 4 + channel;
      const delta = Math.abs(before.rgba8[offset]! - after.rgba8[offset]!);
      if (delta !== 0) changed = true;
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
    }
    if (!changed) continue;
    changedPixels++;
    const x = pixel % before.width;
    const y = Math.floor(pixel / before.width);
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return Object.freeze({
    changedPixels,
    maximumChannelDelta,
    changedBounds: changedPixels === 0 ? null : Object.freeze({ left, top, right, bottom }),
    beforeDecodedPixelDigest: computeSha256(before.rgba8),
    afterDecodedPixelDigest: computeSha256(after.rgba8),
    ...(before.pngBytes === undefined ? {} : { beforePngDigest: computeSha256(before.pngBytes) }),
    ...(after.pngBytes === undefined ? {} : { afterPngDigest: computeSha256(after.pngBytes) }),
  });
}
