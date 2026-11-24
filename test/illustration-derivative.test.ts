import { deflateSync } from "node:zlib";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { computeSha256 } from "../src/digests.js";
import {
  DERIVATIVE_RECIPE_SCHEMA_ID,
  DERIVATIVE_RECIPE_SCHEMA_VERSION,
  DERIVATIVE_RECIPE_DIGEST_BASIS,
  createRasterDerivativeRecipe,
  computeRasterDerivativeRecipeDigest,
  inspectRasterIllustrationSource,
  inspectRasterDerivativePayload,
  parseImageMagickVersion,
  probeMagickDerivativeCapability,
  renderRasterDerivative,
  renderSceneWebp,
  renderSceneWebpWithNixMagick,
  verifyRasterDerivativeOutput,
  supportsImageMagickFormat,
  validateRasterDerivativeRecipe,
  type ImageMagickProcessorDescriptorV1,
  type RasterDerivativeRecipeWithoutDigestV1,
} from "../src/illustration/derivative.js";

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
