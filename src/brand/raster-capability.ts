import { computeSha256, type Sha256Digest } from "../digests.js";
import { inflateSync } from "node:zlib";
import type { BrandQaDecodeInput, BrandQaNormalizedRaster, BrandQaRendererCapability, BrandQaRenderInput } from "./qa-capability.js";
import type { RasterAdapterDescriptor } from "./raster-receipt.js";

export const RASTER_COMPANION_PACKAGE = "@knowledge-forge-ai/tfsb-raster-resvg" as const;
export const RASTER_ADAPTER_ID = "resvg-png-v1" as const;
export const RASTER_MAX_SVG_BYTES = 8 * 1_048_576;
export const RASTER_MAX_PNG_BYTES = 32 * 1_048_576;
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function runtimePlatformClaim(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  return `${process.platform}-${process.arch}`;
}

export interface RasterRenderRequest {
  readonly canonicalSvgBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly backgroundRgba: readonly [number, number, number, number] | null;
  readonly alpha: "straight" | "opaque";
  readonly fit: "contain-pad";
  readonly colorSpace: "srgb";
}

export interface RasterAdapterRenderResult {
  readonly width: number;
  readonly height: number;
  readonly rgba8: Uint8Array;
  readonly pngBytes: Uint8Array;
  readonly descriptor: RasterAdapterDescriptor;
}

export interface RasterAdapterCapability {
  readonly descriptor: RasterAdapterDescriptor;
  readonly renderSvg: (request: RasterRenderRequest) => Promise<RasterAdapterRenderResult>;
}

export type RasterCapabilityStatus =
  | Readonly<{ available: true; adapter: RasterAdapterCapability; qa: BrandQaRendererCapability }>
  | Readonly<{ available: false; code: "EXPORT_CAPABILITY_UNAVAILABLE"; reason: string }>;

interface CompanionModule {
  readonly descriptor: RasterAdapterDescriptor;
  readonly renderSvg: (request: RasterRenderRequest) => Promise<RasterAdapterRenderResult>;
}

export interface StrictPngDecodeResult extends BrandQaNormalizedRaster {
  readonly chunkTypes: readonly string[];
  readonly pngDigest: Sha256Digest;
  readonly decodedPixelDigest: Sha256Digest;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let value = n; for (let k = 0; k < 8; k++) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[n] = value >>> 0; }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const dl = Math.abs(estimate - left), da = Math.abs(estimate - above), du = Math.abs(estimate - upperLeft);
  return dl <= da && dl <= du ? left : da <= du ? above : upperLeft;
}

function assertRasterDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 16_777_216) throw new Error("Raster dimensions exceed the closed export limits.");
}

export function decodeStrictPng(pngBytes: Uint8Array, expectedWidth?: number, expectedHeight?: number): StrictPngDecodeResult {
  if (!(pngBytes instanceof Uint8Array) || pngBytes.byteLength < 8 || pngBytes.byteLength > RASTER_MAX_PNG_BYTES) throw new Error("PNG bytes must be a bounded Uint8Array.");
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (pngBytes[i] !== PNG_SIGNATURE[i]) throw new Error("Invalid PNG signature.");
  let offset = 8, width = 0, height = 0, colorType = -1, sawIhdr = false, sawIdat = false, endedIdat = false, sawIend = false;
  const idat: Uint8Array[] = [], chunkTypes: string[] = [];
  while (offset < pngBytes.length) {
    if (offset + 12 > pngBytes.length) throw new Error("Truncated PNG chunk.");
    const view = new DataView(pngBytes.buffer, pngBytes.byteOffset + offset, pngBytes.byteLength - offset);
    const length = view.getUint32(0, false); if (length > RASTER_MAX_PNG_BYTES || offset + 12 + length > pngBytes.length) throw new Error("Invalid PNG chunk length.");
    const typeBytes = pngBytes.subarray(offset + 4, offset + 8); const type = String.fromCharCode(...typeBytes);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("Invalid PNG chunk type.");
    const data = pngBytes.subarray(offset + 8, offset + 8 + length); const declaredCrc = view.getUint32(8 + length, false);
    const crcInput = new Uint8Array(4 + length); crcInput.set(typeBytes); crcInput.set(data, 4); if (crc32(crcInput) !== declaredCrc) throw new Error(`PNG ${type} CRC mismatch.`);
    chunkTypes.push(type);
    if (!sawIhdr && type !== "IHDR") throw new Error("IHDR must be the first PNG chunk.");
    if (type === "IHDR") {
      if (sawIhdr || length !== 13) throw new Error("PNG must contain exactly one valid IHDR."); sawIhdr = true;
      const ihdr = new DataView(data.buffer, data.byteOffset, data.byteLength); width = ihdr.getUint32(0, false); height = ihdr.getUint32(4, false); assertRasterDimensions(width, height);
      const bitDepth = data[8]!; colorType = data[9]!; if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error("PNG must be noninterlaced 8-bit RGB or RGBA.");
    } else if (type === "IDAT") {
      if (sawIend || endedIdat) throw new Error("PNG IDAT chunks must be contiguous."); sawIdat = true; idat.push(new Uint8Array(data));
    } else if (type === "IEND") {
      if (!sawIdat || sawIend || length !== 0) throw new Error("Invalid PNG IEND."); sawIend = true; offset += 12 + length; if (offset !== pngBytes.length) throw new Error("Data follows PNG IEND."); break;
    } else {
      if ((typeBytes[0]! & 0x20) === 0) throw new Error(`Unknown critical PNG chunk '${type}'.`);
      throw new Error(`Unapproved ancillary PNG chunk '${type}'.`);
    }
    if (sawIdat && type !== "IDAT") endedIdat = true;
    offset += 12 + length;
  }
  if (!sawIhdr || !sawIdat || !sawIend) throw new Error("PNG is missing required chunks.");
  if (expectedWidth !== undefined && width !== expectedWidth || expectedHeight !== undefined && height !== expectedHeight) throw new Error("PNG dimensions do not match the request.");
  const compressedLength = idat.reduce((sum, bytes) => sum + bytes.length, 0); const compressed = new Uint8Array(compressedLength); let cursor = 0; for (const bytes of idat) { compressed.set(bytes, cursor); cursor += bytes.length; }
  const channels = colorType === 6 ? 4 : 3, stride = width * channels, expectedInflated = (stride + 1) * height;
  let inflated: Uint8Array;
  try { inflated = new Uint8Array(inflateSync(compressed, { maxOutputLength: expectedInflated })); } catch { throw new Error("Invalid or oversized PNG compressed data."); }
  if (inflated.length !== expectedInflated) throw new Error("PNG decompressed byte count mismatch.");
  const scanlines = new Uint8Array(stride * height);
  for (let row = 0; row < height; row++) {
    const inputBase = row * (stride + 1), filter = inflated[inputBase]!; if (filter > 4) throw new Error("Unsupported PNG filter.");
    const outputBase = row * stride, priorBase = outputBase - stride;
    for (let column = 0; column < stride; column++) {
      const raw = inflated[inputBase + 1 + column]!; const left = column >= channels ? scanlines[outputBase + column - channels]! : 0; const above = row > 0 ? scanlines[priorBase + column]! : 0; const upperLeft = row > 0 && column >= channels ? scanlines[priorBase + column - channels]! : 0;
      const reconstructed = filter === 0 ? raw : filter === 1 ? raw + left : filter === 2 ? raw + above : filter === 3 ? raw + Math.floor((left + above) / 2) : raw + paeth(left, above, upperLeft);
      scanlines[outputBase + column] = reconstructed & 0xff;
    }
  }
  const rgba8 = new Uint8Array(width * height * 4);
  if (colorType === 6) rgba8.set(scanlines); else for (let pixel = 0; pixel < width * height; pixel++) { rgba8[pixel * 4] = scanlines[pixel * 3]!; rgba8[pixel * 4 + 1] = scanlines[pixel * 3 + 1]!; rgba8[pixel * 4 + 2] = scanlines[pixel * 3 + 2]!; rgba8[pixel * 4 + 3] = 255; }
  return Object.freeze({ width, height, rgba8, pngBytes: new Uint8Array(pngBytes), chunkTypes: Object.freeze(chunkTypes), pngDigest: computeSha256(pngBytes), decodedPixelDigest: computeSha256(rgba8) });
}

export function assertRasterSvgIsSelfContained(canonicalSvgBytes: Uint8Array): void {
  if (!(canonicalSvgBytes instanceof Uint8Array) || canonicalSvgBytes.length < 1 || canonicalSvgBytes.length > RASTER_MAX_SVG_BYTES) throw new Error("Canonical SVG bytes exceed the closed source limit.");
  const svg = new TextDecoder("utf-8", { fatal: true }).decode(canonicalSvgBytes);
  const forbidden = [/<image\b/iu, /<foreignObject\b/iu, /<style\b/iu, /\sstyle\s*=/iu, /<text\b/iu, /font(?:-family|-face|:)/iu, /data:image\//iu, /data:(?:font\/|application\/(?:font-|x-font-))/iu, /(?:href|xlink:href)\s*=\s*["'](?!#)/iu, /\burl\s*\(\s*(?!#)/iu, /@import\b/iu];
  if (forbidden.some((pattern) => pattern.test(svg))) throw new Error("SVG contains unsupported external, raster, style, or font authority.");
}

export function validateRasterDescriptor(value: RasterAdapterDescriptor): RasterAdapterDescriptor {
  const keys = Object.keys(value).sort(); const expected = ["adapterId", "backend", "companionPackage", "companionVersion", "nodeMajor", "platformClaim", "qualificationId", "rendererBuildDigest", "rendererPackage", "rendererVersion"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("Raster adapter descriptor has an incompatible shape.");
  if (value.adapterId !== RASTER_ADAPTER_ID || value.companionPackage !== RASTER_COMPANION_PACKAGE || value.backend !== "wasm" || value.rendererPackage !== "@resvg/resvg-wasm" || !/^sha256:[0-9a-f]{64}$/.test(value.rendererBuildDigest) || value.nodeMajor !== Number(process.versions.node.split(".")[0]) || value.platformClaim !== runtimePlatformClaim()) throw new Error("Raster adapter descriptor is incompatible with this runtime.");
  return Object.freeze({ ...value });
}

export function createRasterCapabilityFromModule(moduleValue: unknown): RasterCapabilityStatus {
  if (typeof moduleValue !== "object" || moduleValue === null || Array.isArray(moduleValue)) return Object.freeze({ available: false, code: "EXPORT_CAPABILITY_UNAVAILABLE", reason: "Companion module is not an object." });
  const module = moduleValue as Partial<CompanionModule>; const keys = Object.keys(moduleValue).sort();
  if (keys.length !== 2 || keys[0] !== "descriptor" || keys[1] !== "renderSvg" || typeof module.renderSvg !== "function" || module.descriptor === undefined) return Object.freeze({ available: false, code: "EXPORT_CAPABILITY_UNAVAILABLE", reason: "Companion module export shape is incompatible." });
  let descriptor: RasterAdapterDescriptor; try { descriptor = validateRasterDescriptor(module.descriptor); } catch (error) { return Object.freeze({ available: false, code: "EXPORT_CAPABILITY_UNAVAILABLE", reason: error instanceof Error ? error.message : "Invalid descriptor." }); }
  const adapter: RasterAdapterCapability = Object.freeze({ descriptor, renderSvg: async (request: RasterRenderRequest) => {
    assertRasterDimensions(request.width, request.height); assertRasterSvgIsSelfContained(request.canonicalSvgBytes);
    const raw = await module.renderSvg!(Object.freeze({ ...request, canonicalSvgBytes: new Uint8Array(request.canonicalSvgBytes), backgroundRgba: request.backgroundRgba === null ? null : Object.freeze([...request.backgroundRgba] as [number, number, number, number]) }));
    if (typeof raw !== "object" || raw === null || Object.keys(raw).sort().join(",") !== "descriptor,height,pngBytes,rgba8,width") throw new Error("Adapter returned an incompatible shape.");
    if (raw.width !== request.width || raw.height !== request.height || !(raw.rgba8 instanceof Uint8Array) || raw.rgba8.length !== request.width * request.height * 4 || !(raw.pngBytes instanceof Uint8Array) || raw.pngBytes.length > RASTER_MAX_PNG_BYTES) throw new Error("Adapter returned invalid bounded raster data.");
    if (encodeDescriptor(raw.descriptor) !== encodeDescriptor(descriptor)) throw new Error("Adapter result descriptor changed.");
    const decoded = decodeStrictPng(raw.pngBytes, request.width, request.height); if (!Buffer.from(decoded.rgba8).equals(Buffer.from(raw.rgba8))) throw new Error("Adapter PNG pixels differ from normalized RGBA output.");
    if (request.alpha === "opaque") for (let i = 3; i < raw.rgba8.length; i += 4) if (raw.rgba8[i] !== 255) throw new Error("Opaque export contains nonopaque pixels.");
    return Object.freeze({ width: raw.width, height: raw.height, rgba8: new Uint8Array(raw.rgba8), pngBytes: new Uint8Array(raw.pngBytes), descriptor });
  } });
  const qa: BrandQaRendererCapability = Object.freeze({ descriptor: Object.freeze({ id: descriptor.adapterId, version: descriptor.rendererVersion, platformClaim: descriptor.platformClaim, qualificationId: descriptor.qualificationId }), renderSvg: async (input: BrandQaRenderInput) => { const rendered = await adapter.renderSvg({ canonicalSvgBytes: input.canonicalSvgBytes, width: input.width, height: input.height, backgroundRgba: input.backgroundRgba, alpha: input.configuration.alpha, fit: "contain-pad", colorSpace: input.configuration.colorSpace }); return Object.freeze({ width: rendered.width, height: rendered.height, rgba8: rendered.rgba8, pngBytes: rendered.pngBytes }); }, decodePng: async (input: BrandQaDecodeInput) => { const decoded = decodeStrictPng(input.pngBytes, input.expectedWidth, input.expectedHeight); return Object.freeze({ width: decoded.width, height: decoded.height, rgba8: decoded.rgba8, pngBytes: new Uint8Array(input.pngBytes) }); } });
  return Object.freeze({ available: true, adapter, qa });
}

function encodeDescriptor(value: RasterAdapterDescriptor): string { return JSON.stringify(value); }

export async function loadRasterCapability(): Promise<RasterCapabilityStatus> {
  try {
    const fixedSpecifier: string = RASTER_COMPANION_PACKAGE;
    return createRasterCapabilityFromModule(await import(fixedSpecifier));
  } catch (error) {
    return Object.freeze({ available: false, code: "EXPORT_CAPABILITY_UNAVAILABLE", reason: error instanceof Error && /Cannot find package|ERR_MODULE_NOT_FOUND/.test(`${error.name} ${error.message}`) ? "Optional raster companion is not installed." : "Optional raster companion could not be loaded." });
  }
}
