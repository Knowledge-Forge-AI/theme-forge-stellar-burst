import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const { decodeStrictPng } = await import(new URL("../dist/brand/raster-capability.js", import.meta.url).href);

import { descriptor, renderSvg } from "../packages/tfsb-raster-resvg/index.js";

const corpusUrl = new URL("../test/fixtures/raster-golden/corpus.json", import.meta.url);
const corpus = JSON.parse(await readFile(corpusUrl, "utf8"));
/** @param {Uint8Array} bytes */
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/** @param {Uint8Array} bytes */
const chunks = (bytes) => { const result = []; for (let offset = 8; offset < bytes.length;) { const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0); result.push(Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString("ascii")); offset += length + 12; } return result; };
const matrix = [];
for (const item of corpus.cases) {
  const rendered = await renderSvg({ canonicalSvgBytes: Buffer.from(item.svg), width: item.width, height: item.height, backgroundRgba: item.background, alpha: item.alpha, fit: "contain-pad", colorSpace: "srgb" });
  const decoded = decodeStrictPng(rendered.pngBytes, rendered.width, rendered.height);
  if (!Buffer.from(decoded.rgba8).equals(Buffer.from(rendered.rgba8))) throw new Error("Renderer RGBA differs from its independently decoded PNG.");
  matrix.push({ id: item.id, width: rendered.width, height: rendered.height, alpha: item.alpha, chunks: chunks(rendered.pngBytes), pngDigest: sha(rendered.pngBytes), decodedPixelDigest: sha(rendered.rgba8) });
}
process.stdout.write(`${JSON.stringify({ descriptor, matrix })}\n`);
