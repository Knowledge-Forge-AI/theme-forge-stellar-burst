import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { computeSha256 } from "../src/digests.js";
import { createRasterDerivativeRecipe } from "../src/illustration/derivative.js";
import { writeIllustrationCarrier } from "../src/illustration/carrier-write.js";
import { createRasterIllustrationRecord } from "../src/illustration/v1.js";

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const body = new Uint8Array(typeBytes.byteLength + data.byteLength);
  body.set(typeBytes); body.set(data, typeBytes.byteLength);
  const result = new Uint8Array(12 + data.byteLength);
  new DataView(result.buffer).setUint32(0, data.byteLength, false);
  result.set(body, 4);
  new DataView(result.buffer).setUint32(result.byteLength - 4, crc32(body), false);
  return result;
}

/** Tiny deterministic RGBA PNG fixture; it is parser/custody input only. */
export function png(width: number, height: number): Uint8Array {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width * 4 + 1);
    raw[offset] = 0;
    for (let pixel = 0; pixel < width; pixel += 1) {
      raw[offset + 1 + pixel * 4] = 31;
      raw[offset + 2 + pixel * 4] = 97;
      raw[offset + 3 + pixel * 4] = 181;
      raw[offset + 4 + pixel * 4] = 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width, false); header.setUint32(4, height, false);
  ihdr[8] = 8; ihdr[9] = 6;
  const idat = new Uint8Array(deflateSync(raw));
  const iend = new Uint8Array(0);
  const chunks = [chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", iend)];
  const result = new Uint8Array(PNG_SIGNATURE.byteLength + chunks.reduce((total, value) => total + value.byteLength, 0));
  result.set(PNG_SIGNATURE);
  let offset = PNG_SIGNATURE.byteLength;
  for (const value of chunks) { result.set(value, offset); offset += value.byteLength; }
  return result;
}

export interface FixtureCarrier {
  readonly root: string;
  readonly carrier: string;
  readonly payload: Uint8Array;
}

export async function temporary(owned: string[]): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "tfsb-registry530-"));
  owned.push(root);
  return root;
}

export async function makeCarrier(root: string, options: {
  readonly revision?: number;
  readonly derivatives?: number;
  readonly width?: number;
  readonly height?: number;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
} = {}): Promise<FixtureCarrier> {
  const revision = options.revision ?? 1;
  const count = options.derivatives ?? 1;
  const width = options.width ?? 1;
  const height = options.height ?? 1;
  const sourceWidth = options.sourceWidth ?? width;
  const sourceHeight = options.sourceHeight ?? height;
  const sourcePayload = png(sourceWidth, sourceHeight);
  const payload = png(width, height);
  const sourceSha256 = computeSha256(sourcePayload);
  const recipes = Array.from({ length: count }, (_, index) => createRasterDerivativeRecipe({
    recipeId: `hero_${index + 1}.preview`,
    recipeRevision: 1,
    sourceSha256,
    sourceMime: "image/png",
    output: { mime: "image/png", width, height, fit: "contain-pad", colorSpace: "srgb", metadata: "stripped", alpha: "preserve", quality: 88, method: 6, filter: "Lanczos" },
    processor: { kind: "imagemagick", executable: "magick", version: "7.1.2-23", binarySha256: null, closureSha256: null, identityScope: "same-host-version-only" },
  }));
  const record = createRasterIllustrationRecord({
    illustrationId: "synthetic_hero.v1",
    revision,
    operation: "import",
    characters: [{ id: "synthetic", revision: 1 }],
    style: { id: "fixture", revision: 1 },
    provider: null,
    model: null,
    source: { sha256: sourceSha256, mime: "image/png", byteLength: sourcePayload.byteLength, dimensions: { width: sourceWidth, height: sourceHeight }, alpha: "opaque" },
    references: [],
    lineage: { parentDigest: null },
    exportRecipes: recipes.map((recipe) => ({ id: recipe.recipeId, recipeSha256: recipe.recipeDigest, mime: "image/png" as const, width, height, alpha: "opaque" as const })),
  });
  const carrier = join(root, `carrier-${revision}-${count}-${width}x${height}`);
  await mkdir(root, { recursive: true });
  await writeIllustrationCarrier({
    directory: carrier,
    packageId: "fixture-art",
    revision,
    record,
    derivatives: recipes.map((recipe) => ({ recipe, bytes: payload })),
  });
  return { root, carrier, payload };
}

export async function cleanup(owned: readonly string[]): Promise<void> {
  for (const root of owned) await rm(root, { recursive: true, force: true });
}
