import { deflateSync, inflateSync } from "node:zlib";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { decodeStrictPng } from "../src/brand/raster-capability.js";
import { computeSha256 } from "../src/digests.js";
import {
  DERIVATIVE_RECIPE_SCHEMA_ID,
  DERIVATIVE_RECIPE_SCHEMA_VERSION,
  DERIVATIVE_RECIPE_DIGEST_BASIS,
  createRasterDerivativeRecipe,
  encodeAreaPng,
  computeRasterDerivativeRecipeDigest,
  inspectRasterIllustrationSource,
  inspectRasterDerivativePayload,
  parseImageMagickVersion,
  probeMagickDerivativeCapability,
  renderRasterDerivative,
  renderSceneWebp,
  renderSceneWebpArea,
  renderSceneWebpWithNixMagick,
  verifyRasterDerivativeOutput,
  supportsImageMagickFormat,
  validateRasterDerivativeRecipe,
  validateRasterDerivativeAreaRecipe,
  type ImageMagickProcessorDescriptorV1,
  type RasterDerivativeRecipeWithoutDigestV1,
} from "../src/illustration/derivative.js";

import { canonicalJson } from "../src/service-protocol/canonical-json.js";

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = encoder.encode(type);
  const checksumInput = Buffer.concat([Buffer.from(typeBytes), Buffer.from(data)]);
  const result = Buffer.alloc(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  Buffer.from(typeBytes).copy(result, 4);
  Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(crc32(checksumInput), 8 + data.byteLength);
  return result;
}

interface PngChunk {
  readonly type: string;
  readonly data: Uint8Array;
}

function pngDocument(chunks: readonly PngChunk[]): Uint8Array {
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ...chunks.map(({ type, data }) => pngChunk(type, data)),
  ]));
}

function pngChunks(source: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < source.byteLength) {
    const length = new DataView(source.buffer, source.byteOffset + offset, 4).getUint32(0, false);
    const dataStart = offset + 8;
    chunks.push({ type: Buffer.from(source.subarray(offset + 4, dataStart)).toString("ascii"), data: new Uint8Array(source.subarray(dataStart, dataStart + length)) });
    offset = dataStart + length + 4;
  }
  return chunks;
}

function pngWithInsertedChunk(source: Uint8Array, chunk: PngChunk, index: number): Uint8Array {
  const chunks = pngChunks(source);
  chunks.splice(index, 0, chunk);
  return pngDocument(chunks);
}

function tinyPng(): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanline = Uint8Array.of(0, 240, 32, 16, 128);
  return pngDocument([
    { type: "IHDR", data: ihdr },
    { type: "IDAT", data: deflateSync(scanline) },
    { type: "IEND", data: new Uint8Array() },
  ]);
}

function patternedPng(): Uint8Array {
  const width = 32, height = 24;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      scanlines[offset] = (x * 37 + y * 17) % 256;
      scanlines[offset + 1] = x < 13 ? 240 : 16;
      scanlines[offset + 2] = (x + y) % 3 === 0 ? 255 : 0;
      scanlines[offset + 3] = x < y ? 128 : 255;
    }
  }
  return pngDocument([
    { type: "IHDR", data: ihdr },
    { type: "IDAT", data: deflateSync(scanlines) },
    { type: "IEND", data: new Uint8Array() },
  ]);
}

function webpChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(8 + data.byteLength + (data.byteLength % 2));
  Buffer.from(type, "ascii").copy(chunk, 0);
  chunk.writeUInt32LE(data.byteLength, 4);
  Buffer.from(data).copy(chunk, 8);
  return chunk;
}

function webpDocument(chunks: readonly { readonly type: string; readonly data: Uint8Array }[]): Uint8Array {
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...chunks.map(({ type, data }) => webpChunk(type, data))]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.byteLength, 4);
  return new Uint8Array(Buffer.concat([header, body]));
}

function webpVp8x(flags = 0): Uint8Array {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data[4] = 3;
  data[7] = 3;
  return data;
}

function webpVp8(width = 4, height = 4): Uint8Array {
  const data = Buffer.alloc(10);
  data[3] = 0x9d;
  data[4] = 0x01;
  data[5] = 0x2a;
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return data;
}

function webpVp8l(alphaUsed = false): Uint8Array {
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data[1] = 3;
  data[2] = 0xc0;
  data[3] = 0;
  data[4] = alphaUsed ? 0x10 : 0;
  return data;
}

function webpWithVp8x(flags = 0, extra: readonly { readonly type: string; readonly data: Uint8Array }[] = []): Uint8Array {
  const alpha = (flags & 0x10) === 0 ? [] : [{ type: "ALPH", data: Uint8Array.of(1) }];
  return webpDocument([{ type: "VP8X", data: webpVp8x(flags) }, ...alpha, { type: "VP8 ", data: webpVp8() }, ...extra]);
}

function webpWithVp8l(alphaUsed = false): Uint8Array {
  return webpDocument([{ type: "VP8L", data: webpVp8l(alphaUsed) }]);
}

function syntheticCaBxPng(): Uint8Array {
  const payload = new Uint8Array(23 * 1_024);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  return pngWithInsertedChunk(tinyPng(), { type: "caBX", data: payload }, 1);
}

function corruptChunkCrc(source: Uint8Array, chunkIndex: number): Uint8Array {
  const corrupted = new Uint8Array(source);
  let offset = 8;
  for (let index = 0; index < chunkIndex; index += 1) {
    const length = new DataView(corrupted.buffer, corrupted.byteOffset + offset, 4).getUint32(0, false);
    offset += 12 + length;
  }
  const length = new DataView(corrupted.buffer, corrupted.byteOffset + offset, 4).getUint32(0, false);
  const crcOffset = offset + 8 + length;
  corrupted[crcOffset] = corrupted[crcOffset]! ^ 1;
  return corrupted;
}

function processor(): ImageMagickProcessorDescriptorV1 {
  return { kind: "imagemagick", executable: "magick", version: "7.1.2-23", binarySha256: null, closureSha256: null, identityScope: "same-host-version-only" };
}

function recipe(source: Uint8Array, overrides: Partial<RasterDerivativeRecipeWithoutDigestV1> = {}) {
  return createRasterDerivativeRecipe({
    recipeId: "thumbnail",
    recipeRevision: 1,
    sourceSha256: computeSha256(source),
    sourceMime: "image/png",
    output: { mime: "image/png", width: 8, height: 8, fit: "contain-pad", colorSpace: "srgb", metadata: "stripped", alpha: "preserve", quality: 90, method: 4, filter: "Lanczos" },
    processor: processor(),
    ...overrides,
  });
}

async function withFakeMagick<T>(output: Uint8Array, callback: () => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "tfsb-derivative-magick-"));
  const previousPath = process.env.PATH;
  await writeFile(join(directory, "payload.bin"), output, { mode: 0o600 });
  await writeFile(join(directory, "magick"), "#!/bin/sh\ncase \"$1 $2\" in\n  \"-version \"*) printf '%s\\n' 'Version: ImageMagick 7.1.2-test' ;;\n  \"-list format\") printf '%s\\n' 'Format Module Mode' 'PNG PNG rw-' 'WEBP WEBP rw-' ;;\n  *) script_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd); cat \"$script_dir/payload.bin\" ;;\nesac\n", { mode: 0o700 });
  process.env.PATH = `${directory}${delimiter}${previousPath ?? ""}`;
  try {
    return await callback();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

describe("raster derivative capability", () => {
  it("creates a closed versioned recipe with deterministic identity", () => {
    const source = tinyPng();
    const value = recipe(source);
    expect(value.schema).toBe(DERIVATIVE_RECIPE_SCHEMA_ID);
    expect(value.schemaVersion).toBe(DERIVATIVE_RECIPE_SCHEMA_VERSION);
    expect(value.recipeDigest).toBe(computeRasterDerivativeRecipeDigest(value));
    expect(computeRasterDerivativeRecipeDigest({ ...value, output: { ...value.output, quality: 89 } })).not.toBe(value.recipeDigest);
    expect(validateRasterDerivativeRecipe(value)).toEqual(value);
    expect(DERIVATIVE_RECIPE_DIGEST_BASIS).toBe("tfsb.raster-derivative-recipe-v1\n");
  });

  it("binds sharp chroma only in a version 2 WebP recipe", () => {
    const { recipeDigest: _old, ...v1 } = recipe(tinyPng());
    const standard = { ...v1, output: { ...v1.output, mime: "image/webp" } };
    const sharp = { ...standard, schemaVersion: 2, output: { ...standard.output, chroma: "sharp-yuv" } };
    const digest = computeRasterDerivativeRecipeDigest(sharp);
    expect(digest).not.toBe(computeRasterDerivativeRecipeDigest(standard));
    expect(validateRasterDerivativeRecipe({ ...sharp, recipeDigest: digest })).toMatchObject(sharp);
    expect(() => computeRasterDerivativeRecipeDigest({ ...sharp, schemaVersion: 1 })).toThrow();
    expect(() => computeRasterDerivativeRecipeDigest({ ...sharp, output: { ...sharp.output, mime: "image/png" } })).toThrow();
    expect(() => computeRasterDerivativeRecipeDigest({ ...sharp, output: { ...sharp.output, chroma: "unknown" } })).toThrow();
  });

  it("rejects unknown fields, unsafe recipes, malformed source magic/checksums, and wrong processor text", async () => {
    const source = tinyPng();
    const value = recipe(source);
    expect(() => validateRasterDerivativeRecipe({ ...value, secret: "not-public" })).toThrow();
    expect(() => createRasterDerivativeRecipe({ ...value, recipeId: "api-key-live" })).toThrow();
    const { output: _output, ...missingOutput } = value;
    expect(() => validateRasterDerivativeRecipe(missingOutput)).toThrow();
    expect(() => validateRasterDerivativeRecipe({ ...value, recipeDigest: computeSha256(encoder.encode("tampered")) })).toThrow();
    expect(() => createRasterDerivativeRecipe({ ...value, output: { ...value.output, width: 16_384, height: 1_025 } })).toThrow();
    expect(parseImageMagickVersion("Version: OtherTool 7.1")).toBeNull();

    const corrupted = new Uint8Array(source);
    const lastByte = corrupted.length - 1;
    corrupted[lastByte] = corrupted[lastByte]! ^ 1;
    const corruptedRecipe = recipe(corrupted);
    await expect(renderRasterDerivative(corrupted, corruptedRecipe)).rejects.toMatchObject({ code: "SOURCE_INVALID" });
    const wrongMime = recipe(source, { sourceMime: "image/webp" });
    await expect(renderRasterDerivative(source, wrongMime)).rejects.toMatchObject({ code: "SOURCE_INVALID" });
    const colorChunk = pngWithInsertedChunk(source, { type: "gAMA", data: Uint8Array.of(0, 0, 0, 1) }, 1);
    await expect(renderRasterDerivative(colorChunk, recipe(colorChunk))).rejects.toMatchObject({ code: "SOURCE_INVALID" });
  });

  it("CRC-validates original PNG order and preflights only valid caBX placements", async () => {
    const afterIhdr = syntheticCaBxPng();
    const afterIdat = pngWithInsertedChunk(tinyPng(), { type: "caBX", data: Uint8Array.of(1, 2, 3) }, 2);
    const multiple = pngWithInsertedChunk(afterIdat, { type: "caBX", data: Uint8Array.of(4, 5, 6) }, 3);
    for (const source of [afterIhdr, afterIdat, multiple]) {
      const wrongProcessor = { ...processor(), version: "0.0.0" };
      await expect(renderRasterDerivative(source, recipe(source, { processor: wrongProcessor }))).rejects.toSatisfy((error: unknown) => error instanceof Error && ["PROCESSOR_UNAVAILABLE", "PROCESSOR_MISMATCH"].includes((error as { readonly code?: string }).code ?? ""));
    }

    const beforeIhdr = pngWithInsertedChunk(tinyPng(), { type: "caBX", data: Uint8Array.of(1, 2, 3) }, 0);
    const chunks = pngChunks(tinyPng());
    const idat = chunks[1]!.data;
    const betweenIdat = pngDocument([
      chunks[0]!,
      { type: "IDAT", data: idat.subarray(0, 1) },
      { type: "caBX", data: Uint8Array.of(1, 2, 3) },
      { type: "IDAT", data: idat.subarray(1) },
      chunks[2]!,
    ]);
    const withGamma = pngWithInsertedChunk(afterIhdr, { type: "gAMA", data: Uint8Array.of(0, 0, 0, 1) }, 2);
    const corrupted = corruptChunkCrc(afterIhdr, 1);
    for (const source of [beforeIhdr, betweenIdat, withGamma, corrupted]) {
      await expect(renderRasterDerivative(source, recipe(source))).rejects.toMatchObject({ code: "SOURCE_INVALID" });
    }
  });

  it("accepts both ImageMagick format-table layouts without trusting descriptions", () => {
    expect(supportsImageMagickFormat("PNG* rw- Portable network graphics\nWEBP rw+ WebP", "PNG")).toBe(true);
    expect(supportsImageMagickFormat("Format Module Mode\nPNG PNG rw- Portable network graphics\nWEBP WEBP rw+ WebP", "WEBP")).toBe(true);
    expect(supportsImageMagickFormat("PNG PNG r-- read-only\n", "PNG")).toBe(false);
    expect(parseImageMagickVersion("Version: ImageMagick 7.1.2-23 Q16-HDRI\n")).toBe("7.1.2-23");
  });

  it("strictly rejects WebP metadata chunks and VP8X metadata or animation flags", async () => {
    const source = tinyPng();
    const outputCases: readonly [string, Uint8Array][] = [
      ["EXIF", webpWithVp8x(0, [{ type: "EXIF", data: Uint8Array.of(1) }])],
      ["XMP ", webpWithVp8x(0, [{ type: "XMP ", data: Uint8Array.of(1) }])],
      ["ICCP", webpWithVp8x(0, [{ type: "ICCP", data: Uint8Array.of(1) }])],
      ["C2PA", webpWithVp8x(0, [{ type: "C2PA", data: Uint8Array.of(1) }])],
      ["flags", webpWithVp8x(0x2e)],
    ];
    for (const [, output] of outputCases) {
      await withFakeMagick(output, async () => {
        const value = recipe(source, {
          processor: { ...processor(), version: "7.1.2-test" },
          output: { ...recipe(source).output, mime: "image/webp", width: 4, height: 4 },
        });
        await expect(renderRasterDerivative(source, value)).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
      });
    }
  });

  it("rejects WebP source metadata, animation, unknown chunks, and prohibited VP8X flags before probing", async () => {
    const cleanSource = webpWithVp8x();
    await expect(renderRasterDerivative(cleanSource, recipe(cleanSource, { sourceMime: "image/webp", processor: { ...processor(), version: "0.0.0" } }))).rejects.toSatisfy((error: unknown) => error instanceof Error && ["PROCESSOR_UNAVAILABLE", "PROCESSOR_MISMATCH"].includes((error as { readonly code?: string }).code ?? ""));
    const cases: readonly Uint8Array[] = [
      webpWithVp8x(0, [{ type: "ICCP", data: Uint8Array.of(1) }]),
      webpWithVp8x(0, [{ type: "EXIF", data: Uint8Array.of(1) }]),
      webpWithVp8x(0, [{ type: "XMP ", data: Uint8Array.of(1) }]),
      webpWithVp8x(0, [{ type: "ANIM", data: Uint8Array.of(1) }]),
      webpWithVp8x(0, [{ type: "ANMF", data: Uint8Array.of(1) }]),
      webpWithVp8x(0, [{ type: "JUNK", data: Uint8Array.of(1) }]),
      ...[0x20, 0x08, 0x04, 0x02, 0x01, 0x40, 0x80].map((flags) => webpWithVp8x(flags)),
    ];
    for (const source of cases) {
      const value = recipe(source, { sourceMime: "image/webp" });
      await expect(renderRasterDerivative(source, value)).rejects.toMatchObject({ code: "SOURCE_INVALID" });
    }
  });

  it("reports malformed processor WebP output as OUTPUT_INVALID, not SOURCE_INVALID", async () => {
    const source = tinyPng();
    await withFakeMagick(Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80), async () => {
      const value = recipe(source, {
        processor: { ...processor(), version: "7.1.2-test" },
        output: { ...recipe(source).output, mime: "image/webp", width: 4, height: 4 },
      });
      await expect(renderRasterDerivative(source, value)).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
    });
  });

  it("exposes strict saved-payload proof with explicit WebP header-only alpha scope", () => {
    const png = inspectRasterDerivativePayload(tinyPng(), "image/png");
    expect(png).toMatchObject({ width: 1, height: 1, alpha: "has-alpha", verification: "png-pixels-decoded" });
    const webpAlpha = inspectRasterDerivativePayload(webpWithVp8x(0x10), "image/webp");
    expect(webpAlpha).toMatchObject({ width: 4, height: 4, alpha: "has-alpha", verification: "webp-header-only" });
    const webpOpaque = inspectRasterDerivativePayload(webpWithVp8x(), "image/webp");
    expect(webpOpaque).toMatchObject({ width: 4, height: 4, alpha: "opaque", verification: "webp-header-only" });
    const webpLosslessAlpha = inspectRasterDerivativePayload(webpWithVp8l(true), "image/webp");
    expect(webpLosslessAlpha).toMatchObject({ width: 4, height: 4, alpha: "has-alpha", verification: "webp-header-only" });
    const webpLosslessOpaque = inspectRasterDerivativePayload(webpWithVp8l(false), "image/webp");
    expect(webpLosslessOpaque).toMatchObject({ width: 4, height: 4, alpha: "opaque", verification: "webp-header-only" });
  });

  it("inspects source facts without I/O, retaining caBX-aware PNG alpha and WebP header-only alpha", () => {
    const png = syntheticCaBxPng();
    const original = new Uint8Array(png);
    expect(inspectRasterIllustrationSource(png, "image/png")).toMatchObject({ width: 1, height: 1, alpha: "has-alpha", verification: "png-pixels-decoded" });
    expect(png).toEqual(original);
    expect(inspectRasterIllustrationSource(webpWithVp8x(0x10), "image/webp")).toMatchObject({ width: 4, height: 4, alpha: "unknown", verification: "webp-header-only" });
    const withGamma = pngWithInsertedChunk(tinyPng(), { type: "gAMA", data: Uint8Array.of(0, 0, 0, 1) }, 1);
    expect(() => inspectRasterIllustrationSource(withGamma, "image/png")).toThrow();
    expect(() => inspectRasterIllustrationSource(webpWithVp8x(0, [{ type: "EXIF", data: Uint8Array.of(1) }]), "image/webp")).toThrow();
    expect(() => inspectRasterIllustrationSource(png, "image/gif" as never)).toThrow();
  });

  it("enforces the small structural WebP invariants used by the closed header proof", () => {
    const reserved = new Uint8Array(webpWithVp8x());
    reserved[21] = 1;
    expect(() => inspectRasterDerivativePayload(reserved, "image/webp")).toThrowError(/Raster derivative operation failed/u);
    const alphaBeforeVp8x = webpDocument([{ type: "ALPH", data: Uint8Array.of(1) }, { type: "VP8X", data: webpVp8x(0x10) }, { type: "VP8 ", data: webpVp8() }]);
    const alphaTwice = webpDocument([{ type: "VP8X", data: webpVp8x(0x10) }, { type: "ALPH", data: Uint8Array.of(1) }, { type: "ALPH", data: Uint8Array.of(2) }, { type: "VP8 ", data: webpVp8() }]);
    const alphaAfterVp8 = webpWithVp8x(0x10, [{ type: "ALPH", data: Uint8Array.of(1) }]);
    const canvasMismatch = webpDocument([{ type: "VP8X", data: webpVp8x() }, { type: "VP8 ", data: webpVp8(3, 4) }]);
    for (const bytes of [alphaBeforeVp8x, alphaTwice, alphaAfterVp8, canvasMismatch]) expect(() => inspectRasterDerivativePayload(bytes, "image/webp")).toThrow();
  });

  it("repeats PNG bytes and proves dimensions/alpha through the fixed processor when available", async ({ skip }) => {
    const capability = await probeMagickDerivativeCapability();
    if (!capability.available) { skip("Fixed ImageMagick capability unavailable on this runtime."); return; }
    const source = tinyPng();
    const original = new Uint8Array(source);
    const value = recipe(source, { processor: capability.processor });
    const first = await renderRasterDerivative(source, value);
    const second = await renderRasterDerivative(source, value);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.sha256).toBe(second.sha256);
    expect(first.recipeDigest).toBe(value.recipeDigest);
    expect(first.width).toBe(8);
    expect(first.height).toBe(8);
    expect(first.alpha).toBe("has-alpha");
    expect(first.verification).toBe("png-pixels-decoded");
    expect(source).toEqual(original);
  }, 60_000);

  it("accepts a valid caBX source and proves the PNG output is strict-decoder clean", async ({ skip }) => {
    const capability = await probeMagickDerivativeCapability();
    if (!capability.available) { skip("Fixed ImageMagick capability unavailable on this runtime."); return; }
    const source = syntheticCaBxPng();
    const value = recipe(source, { processor: capability.processor });
    const result = await renderRasterDerivative(source, value);
    expect(result.verification).toBe("png-pixels-decoded");
    expect(inspectRasterDerivativePayload(result.bytes, "image/png")).toMatchObject({ verification: "png-pixels-decoded", width: 8, height: 8 });
  }, 60_000);

  it("refuses an unpinned executable and a cancelled bound export", async () => {
    const source = tinyPng();
    const sha256 = computeSha256(source);
    const authority = { path: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-imagemagick-7.1/bin/magick", sha256 };
    await expect(renderSceneWebpWithNixMagick(source, 4, 4, { ...authority, path: "magick" }))
      .rejects.toMatchObject({ code: "PROCESSOR_MISMATCH" });
    await expect(renderSceneWebpWithNixMagick(source, 4, 4, authority, AbortSignal.abort()))
      .rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
  });

  it("binds scene WebP bytes to the recipe and keeps destination handling outside the encoder", async ({ skip }) => {
    const capability = await probeMagickDerivativeCapability();
    if (!capability.available) {
      skip("Fixed ImageMagick capability unavailable on this runtime.");
      return;
    }
    const source = tinyPng();
    const sourceDigest = computeSha256(source);
    const { recipe, output, receipt } = await renderSceneWebp(source, 4, 4);
    const mutableSource = new Uint8Array(source);
    const pendingRepeat = renderSceneWebp(mutableSource, 4, 4);
    mutableSource.fill(0);
    const repeated = await pendingRepeat;
    expect(recipe).toMatchObject({
      recipeId: "scene-webp",
      sourceSha256: sourceDigest,
      output: { width: 4, height: 4, alpha: "preserve", quality: 94, method: 6, filter: "Lanczos" },
    });
    expect(receipt).toMatchObject({
      sourceSha256: sourceDigest, recipeDigest: recipe.recipeDigest,
      outputSha256: computeSha256(output.bytes), alpha: "has-alpha", mime: "image/webp",
    });
    expect(repeated.output.bytes).toEqual(output.bytes);
    expect(repeated.receipt).toEqual(receipt);
    const changedBytes = Uint8Array.from(output.bytes);
    changedBytes[changedBytes.length - 1] = changedBytes[changedBytes.length - 1]! ^ 1;
    expect(() => verifyRasterDerivativeOutput({ ...output, bytes: changedBytes }, recipe)).toThrow(
      expect.objectContaining({ code: "OUTPUT_INVALID" }),
    );
    expect(computeSha256(source)).toBe(sourceDigest);
  }, 60_000);

  for (const sharpChroma of [false, true]) {
    it(`selects and replays every resize filter when downsampling (sharp chroma: ${sharpChroma})`, async ({ skip }) => {
      const capability = await probeMagickDerivativeCapability();
      if (!capability.available) { skip("Fixed ImageMagick capability unavailable on this runtime."); return; }
      const source = patternedPng();
      const sourceDigest = computeSha256(source);
      expect(inspectRasterIllustrationSource(source, "image/png")).toMatchObject({ width: 32, height: 24 });
      const defaultResult = await renderSceneWebp(source, 12, 9, 96, sharpChroma);
      const recipeDigests = new Set<string>();
      const outputDigests = new Set<string>();
      const filters = ["Lanczos", "Catrom", "Mitchell", "Box"] as const;
      for (const filter of filters) {
        const selected = await renderSceneWebp(source, 12, 9, 96, sharpChroma, filter);
        expect(selected.recipe).toMatchObject({
          schemaVersion: sharpChroma ? 2 : 1, sourceSha256: sourceDigest,
          output: { width: 12, height: 9, filter, quality: 96 },
        });
        if (selected.recipe.schemaVersion === 2) expect(selected.recipe.output.chroma).toBe("sharp-yuv");
        else expect(selected.recipe.output).not.toHaveProperty("chroma");
        expect(selected.output).toMatchObject({ width: 12, height: 9, mime: "image/webp" });
        expect(selected.receipt).toMatchObject({
          sourceSha256: sourceDigest, recipeDigest: selected.recipe.recipeDigest,
          outputSha256: computeSha256(selected.output.bytes), width: 12, height: 9,
        });
        const replayed = await renderRasterDerivative(source, selected.recipe);
        expect(replayed.bytes).toEqual(selected.output.bytes);
        expect(verifyRasterDerivativeOutput(replayed, selected.recipe)).toEqual(selected.receipt);
        if (filter === "Lanczos") {
          expect(selected.recipe).toEqual(defaultResult.recipe);
          expect(selected.output.bytes).toEqual(defaultResult.output.bytes);
          expect(selected.receipt).toEqual(defaultResult.receipt);
        }
        recipeDigests.add(selected.recipe.recipeDigest);
        outputDigests.add(selected.output.sha256);
      }
      expect(recipeDigests.size).toBe(filters.length);
      expect(outputDigests.size).toBe(filters.length);
      expect(computeSha256(source)).toBe(sourceDigest);
    }, 60_000);
  }

  it("writes WebP with processor dimension proof when the delegate is available", async ({ skip }) => {
    const capability = await probeMagickDerivativeCapability();
    if (!capability.available) { skip("Fixed ImageMagick capability unavailable on this runtime."); return; }
    const source = tinyPng();
    const value = recipe(source, { processor: capability.processor, output: { mime: "image/webp", width: 4, height: 4, fit: "contain-pad", colorSpace: "srgb", metadata: "stripped", alpha: "preserve", quality: 90, method: 4, filter: "Lanczos" } });
    const result = await renderRasterDerivative(source, value);
    expect(result.mime).toBe("image/webp");
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(result.verification).toBe("processor-decoded-dimensions");
    expect(result.byteLength).toBe(result.bytes.byteLength);
  }, 60_000);

});

describe("area WebP source admission", () => {
  it("refuses an aborted request before PNG processing", async () => {
    await expect(renderSceneWebpArea(new Uint8Array(), {
      width: 1, height: 1, signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
  });

  it("refuses a color-profiled PNG under the strict sRGB source policy", async () => {
    const png = pngWithInsertedChunk(tinyPng(), { type: "gAMA", data: Uint8Array.of(0, 0, 177, 143) }, 1);
    await expect(renderSceneWebpArea(png, { width: 1, height: 1 }))
      .rejects.toMatchObject({ code: "SOURCE_INVALID" });
  });
});

describe("exact-area recipe conformance", () => {
  const v3 = (sourceWidth = 1000, sourceHeight = 1537, width = 384, height = 590) => ({
    schema: DERIVATIVE_RECIPE_SCHEMA_ID, schemaVersion: 3,
    recipeId: "pinned-area", recipeRevision: 1, sourceMime: "image/png",
    sourceSha256: `sha256:${"2".repeat(64)}`, sourceWidth, sourceHeight, processor: processor(),
    output: { mime: "image/webp", width, height, fit: "fill", colorSpace: "srgb", metadata: "stripped",
      alpha: "preserve", quality: 94, method: 6, chroma: "sharp-yuv", resample: "area-srgb-alpha-weighted-v1" },
  });
  const seal = (draft: Record<string, unknown>, version = 3) => ({
    ...draft, recipeDigest: computeSha256(Buffer.from(`tfsb.raster-derivative-recipe-v${version}\n${canonicalJson(draft)}`)),
  });

  it("pins historical recipe digests and keeps Area out of v1/v2 validation", async () => {
    for (const [version, filter, expected] of [
      [1, "Lanczos", "ba3cb5a0e35a464498aaf6b18c56bb2f2b248ba9ac49b8e5dd29f0277ebbda99"],
      [2, "Lanczos", "b3a2f5b23b319455479c562b1ddc111a17e6a7cd2c1174e3b29f4fe84201f8ed"],
      [2, "Box", "f59e85b7ffcf1a71f5509106834218d48b02eacb360d5763eaecbff50861bb09"],
    ] as const) {
      const draft = {
        schema: DERIVATIVE_RECIPE_SCHEMA_ID, schemaVersion: version, recipeId: "pinned-recipe",
        recipeRevision: 1, sourceMime: "image/png", sourceSha256: `sha256:${"2".repeat(64)}`,
        processor: processor(),
        output: { mime: "image/webp", width: 1, height: 1, fit: "contain-pad", colorSpace: "srgb",
          metadata: "stripped", alpha: "preserve", quality: 94, method: 6, filter,
          ...(version === 2 ? { chroma: "sharp-yuv" } : {}) },
      };
      expect(computeRasterDerivativeRecipeDigest(draft)).toBe(`sha256:${expected}`);
      for (const extra of [{ filter: "Area" }, { resample: "area-srgb-alpha-weighted-v1" }]) {
        expect(() => validateRasterDerivativeRecipe(seal({ ...draft, output: { ...draft.output, ...extra } }, version))).toThrow();
      }
    }
    const exact = validateRasterDerivativeAreaRecipe(seal(v3()));
    expect(() => validateRasterDerivativeRecipe(exact)).toThrow();
    await expect(renderRasterDerivative(tinyPng(), exact)).rejects.toMatchObject({ code: "INVALID_RECIPE" });
  });

  it("refuses unsupported fields even when the altered recipe is re-digested", () => {
    const draft = v3();
    const { chroma: _ignored, ...withoutChroma } = draft.output;
    for (const value of [
      { ...draft, sourceMime: "image/webp" }, { ...draft, output: withoutChroma },
      ...[{ mime: "image/png" }, { fit: "contain-pad" }, { resample: "future" }, { filter: "Box" }].map(extra =>
        ({ ...draft, output: { ...draft.output, ...extra } })),
    ]) expect(() => validateRasterDerivativeAreaRecipe(seal(value))).toThrow();
    expect(() => validateRasterDerivativeAreaRecipe({ ...seal(draft), constructor: "forbidden" })).toThrow();
    expect(() => validateRasterDerivativeAreaRecipe(seal(draft, 2))).toThrow();
  });

  it("enforces width-anchored rounding and both axis bounds", () => {
    expect(validateRasterDerivativeAreaRecipe(seal(v3())).output.height).toBe(590);
    expect(validateRasterDerivativeAreaRecipe(seal(v3(4, 2, 3, 2))).output.height).toBe(2);
    for (const invalid of [v3(1000, 1537, 384, 591), v3(4, 2, 3, 1), v3(16000, 1, 1, 0),
      v3(4, 2, 5, 3), v3(4, 2, 4, 3)]) {
      expect(() => validateRasterDerivativeAreaRecipe(seal(invalid))).toThrow();
    }
  });

  it("rejects tampered dimensions and output digest before creating a receipt", () => {
    const exact = validateRasterDerivativeAreaRecipe(seal(v3()));
    const bytes = Uint8Array.of(18, 33, 21);
    const output = { sourceSha256: exact.sourceSha256, recipeDigest: exact.recipeDigest,
      processor: exact.processor, mime: "image/webp", bytes, sha256: computeSha256(bytes),
      byteLength: bytes.byteLength, width: 384, height: 590, alpha: "has-alpha",
      verification: "processor-decoded-dimensions" } as const;
    expect(verifyRasterDerivativeOutput(output, exact).outputSha256).toBe(output.sha256);
    expect(() => verifyRasterDerivativeOutput({ ...output, height: 591 }, exact)).toThrow();
    expect(() => verifyRasterDerivativeOutput({ ...output, bytes: Uint8Array.of(18, 33, 22) }, exact)).toThrow();
  });
});

async function withPngTransportProbe<T>(callback: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "tfsb-area-transport-"));
  const previousPath = process.env.PATH;
  try {
    const singlePixelWebp = webpDocument([{ type: "VP8L", data: Uint8Array.of(0x2f, 0, 0, 0, 0x10) }]);
    await writeFile(join(directory, "image.webp"), singlePixelWebp);
    await writeFile(join(directory, "magick"), `#!/bin/sh
set -eu
directory=\$(dirname "\$0")
printf '%s\\n' "\$*" >> "\$directory/argv.log"
case "\$1 \${2:-}" in
  "-version ") printf '%s\\n' 'Version: ImageMagick 7.1.2-test' ;;
  "-list format") printf '%s\\n' 'PNG PNG rw-' 'WEBP WEBP rw-' ;;
  "png:- -colorspace")
    cat > "\$directory/capture.png"
    if [ -e "\$directory/hold" ]; then
      : > "\$directory/ready"
      exec /bin/sleep 10
    fi
    cat "\$directory/image.webp" ;;
  "webp:- -format") cat >/dev/null; printf '%s' 'WEBP 1 1 srgba' ;;
  *) exit 79 ;;
esac
`, { mode: 0o700 });
    process.env.PATH = `${directory}${delimiter}${previousPath ?? ""}`;
    return await callback(directory);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

describe("versioned WebP process boundary", () => {
  it("preserves v1/v2 argv and sends only bounded PNG bytes on the v3 path", async () => {
    await withPngTransportProbe(async directory => {
      const source = tinyPng();
      for (const [sharp, filter] of [[false, "Lanczos"], [true, "Lanczos"], [true, "Box"]] as const) {
        await writeFile(join(directory, "argv.log"), "");
        const current = await renderSceneWebp(source, 1, 1, 94, sharp, filter);
        const calls = (await readFile(join(directory, "argv.log"), "utf8")).trimEnd().split("\n");
        expect(calls.slice(0, 4)).toEqual(["-version", "-list format", "-version", "-list format"]);
        expect(calls[5]).toBe("webp:- -format %m %w %h %[channels] info:-");
        expect(calls).toHaveLength(6);
        const line = calls[4];
        expect(line).toBe(`png:- -colorspace sRGB -filter ${filter} -resize 1x1 -gravity center -background none -extent 1x1 -strip -depth 8 -quality 94 -define webp:method=6${sharp ? " -define webp:use-sharp-yuv=true" : ""} webp:-`);
        expect(current.recipe.schemaVersion).toBe(sharp ? 2 : 1);
        expect(await readFile(join(directory, "capture.png"))).toEqual(Buffer.from(source));
      }
      await writeFile(join(directory, "argv.log"), "");
      const area = await renderSceneWebpArea(source, { width: 1, height: 1 });
      expect(area.recipe.schemaVersion).toBe(3);
      expect((await readFile(join(directory, "argv.log"), "utf8")).trimEnd().split("\n")).toEqual([
        "-version",
        "-list format",
        "png:- -colorspace sRGB -strip -depth 8 -quality 94 -define webp:method=6 -define webp:use-sharp-yuv=true webp:-",
        "webp:- -format %m %w %h %[channels] info:-",
      ]);
      expect(decodeStrictPng(await readFile(join(directory, "capture.png")), 1, 1).rgba8)
        .toEqual(Uint8Array.of(240, 32, 16, 128));
    });
  });

  it("keeps pre-abort and transform deadline failures before encoder invocation", async () => {
    await withPngTransportProbe(async directory => {
      const log = join(directory, "argv.log");
      const source = tinyPng();
      await writeFile(log, "");
      await expect(renderSceneWebpArea(source, { width: 1, height: 1, signal: AbortSignal.abort() }))
        .rejects.toMatchObject({ code: "PROCESS_CANCELLED" });
      expect(await readFile(log, "utf8")).toBe("");
      let tick = 0;
      const deadline = vi.spyOn(performance, "now").mockImplementation(() => tick += 20_000);
      try {
        await expect(renderSceneWebpArea(source, { width: 1, height: 1 })).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
      } finally {
        deadline.mockRestore();
      }
      expect(await readFile(log, "utf8")).toBe("-version\n-list format\n");
    });
  });

  it("cancels an active Area encoder after the PNG reaches the process", async () => {
    await withPngTransportProbe(async directory => {
      await writeFile(join(directory, "hold"), "");
      const controller = new AbortController();
      const active = renderSceneWebpArea(tinyPng(), { width: 1, height: 1, signal: controller.signal });
      const outcome = active.catch((error: unknown) => error);
      const limit = Date.now() + 2000;
      try {
        for (;;) {
          try { await access(join(directory, "ready")); break; } catch {
            if (Date.now() >= limit) throw new Error("Test encoder did not receive its PNG.");
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
      } finally {
        controller.abort();
        expect(await outcome).toMatchObject({ code: "PROCESS_CANCELLED" });
      }
    });
  });
});

describe("Area PNG handoff structure", () => {
  it.each([[1, 1], [5, 3], [3, 4]] as const)("round-trips a fixed %s × %s RGBA layout", (width, height) => {
    const rgba = Uint8Array.from({ length: width * height * 4 }, (_, index) => index % 4 === 3
      ? [0, 20, 255, 176][Math.floor(index / 4) % 4]!
      : (index * 37 + Math.floor(index / 4)) & 255);
    const png = encodeAreaPng(rgba, width, height);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunks = pngChunks(png);
    expect(chunks.map(chunk => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header.set([8, 6], 8);
    expect(chunks[0]!.data).toEqual(new Uint8Array(header));
    expect(inflateSync(chunks[1]!.data).filter((_byte, index) => index % (width * 4 + 1) === 0))
      .toEqual(Buffer.alloc(height));
    expect(decodeStrictPng(png, width, height).rgba8).toEqual(rgba);
    expect(() => decodeStrictPng(corruptChunkCrc(png, 1))).toThrow(/CRC/u);
  });

  it("classifies compressed handoff overflow separately from an invalid layout", () => {
    expect(() => encodeAreaPng(Uint8Array.of(10, 15, 20, 255), 1, 1, 58))
      .toThrow(expect.objectContaining({ code: "PROCESS_OUTPUT_LIMIT" }));
    expect(() => encodeAreaPng(Uint8Array.of(10, 15, 20), 1, 1))
      .toThrow(expect.objectContaining({ code: "SOURCE_INVALID" }));
  });
});
