import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { initWasm, Resvg } from "@resvg/resvg-wasm";

const rendererBuildDigest = "sha256:22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70";
const wasmUrl = import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm");
const wasmBytes = readFileSync(fileURLToPath(wasmUrl));
if (`sha256:${createHash("sha256").update(wasmBytes).digest("hex")}` !== rendererBuildDigest || wasmBytes.length !== 2_478_606) throw new Error("Fixed resvg WASM artifact identity mismatch.");
const runtimePlatformClaim = process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64"
  : process.platform === "darwin" && process.arch === "x64" ? "darwin-x64"
    : process.platform === "linux" && process.arch === "x64" ? "linux-x64-gnu"
      : process.platform === "win32" && process.arch === "x64" ? "windows-x64"
        : `${process.platform}-${process.arch}`;

export const descriptor = Object.freeze({
  adapterId: "resvg-png-v1",
  companionPackage: "@knowledge-forge-ai/tfsb-raster-resvg",
  companionVersion: "0.0.0-tfsb47f",
  backend: "wasm",
  rendererPackage: "@resvg/resvg-wasm",
  rendererVersion: "2.6.2",
  rendererBuildDigest,
  nodeMajor: 22,
  platformClaim: runtimePlatformClaim,
  qualificationId: "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11",
});

let initialization;
function initialize() {
  initialization ??= initWasm(new Uint8Array(wasmBytes));
  return initialization;
}

/** @param {Uint8Array} bytes */
function decodeSvg(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 8 * 1_048_576) throw new Error("Canonical SVG bytes are invalid.");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<(?:image|style|text|foreignObject)\b/iu.test(source) || /<(?:use|a)\b[^>]*(?:href|xlink:href)\s*=\s*["'](?!#)/iu.test(source) || /\burl\s*\(\s*(?!#)/iu.test(source) || /\b(?:@font-face|font-family)\b/iu.test(source)) throw new Error("Raster source contains external image, font, style, or network authority.");
  return source;
}

/** @param {string} source @param {number} width @param {number} height */
function exactCanvasSvg(source, width, height) {
  const declaration = '<?xml version="1.0" encoding="UTF-8"?>\n';
  const svgStart = source.startsWith("<svg ") ? 0 : source.startsWith(`${declaration}<svg `) ? declaration.length : -1;
  const end = source.indexOf(">", svgStart);
  if (svgStart < 0 || end < 0) throw new Error("Canonical SVG root is invalid.");
  let opening = source.slice(svgStart, end);
  if (!/\sviewBox=(?:"[^"]+"|'[^']+')/u.test(opening)) throw new Error("Raster source requires an explicit viewBox.");
  opening = opening.replace(/\s(?:width|height|preserveAspectRatio)=(?:"[^"]*"|'[^']*')/gu, "");
  return `${source.slice(0, svgStart)}${opening} width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet">${source.slice(end + 1)}`;
}

/** @param {readonly [number, number, number, number] | null} value */
function background(value) {
  if (value === null) return undefined;
  if (value.length !== 4 || value.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) throw new Error("Background RGBA is invalid.");
  return `rgba(${value[0]},${value[1]},${value[2]},${value[3] / 255})`;
}

/** @param {Uint8Array} rgba8 */
function normalizeStraightAlpha(rgba8) {
  for (let index = 0; index < rgba8.length; index += 4) {
    const alpha = rgba8[index + 3];
    if (alpha === 0) {
      rgba8[index] = 0;
      rgba8[index + 1] = 0;
      rgba8[index + 2] = 0;
    } else if (alpha !== 255) {
      rgba8[index] = Math.min(255, Math.round(rgba8[index] * 255 / alpha));
      rgba8[index + 1] = Math.min(255, Math.round(rgba8[index + 1] * 255 / alpha));
      rgba8[index + 2] = Math.min(255, Math.round(rgba8[index + 2] * 255 / alpha));
    }
  }
  return rgba8;
}

/**
 * @param {{canonicalSvgBytes: Uint8Array, width: number, height: number, backgroundRgba: readonly [number, number, number, number] | null, alpha: "straight" | "opaque", fit: "contain-pad", colorSpace: "srgb"}} request
 */
export async function renderSvg(request) {
  if (typeof request !== "object" || request === null || Object.keys(request).sort().join(",") !== "alpha,backgroundRgba,canonicalSvgBytes,colorSpace,fit,height,width") throw new Error("Raster request shape is invalid.");
  if (process.versions.node.split(".")[0] !== "22" || !["darwin-arm64", "darwin-x64", "linux-x64-gnu", "windows-x64"].includes(runtimePlatformClaim)) throw new Error("Current runtime tuple is not qualified.");
  await initialize();
  const svg = exactCanvasSvg(decodeSvg(request.canonicalSvgBytes), request.width, request.height);
  /** @type {import("@resvg/resvg-wasm").ResvgRenderOptions} */
  const commonOptions = {
    fitTo: /** @type {const} */ ({ mode: "original" }),
    font: { loadSystemFonts: false, fontFiles: [], fontDirs: [], defaultFontFamily: "" },
  };
  /** @type {import("@resvg/resvg-wasm").ResvgRenderOptions} */
  const options = request.backgroundRgba === null
    ? commonOptions
    : { ...commonOptions, background: /** @type {string} */ (background(request.backgroundRgba)) };
  const renderer = new Resvg(svg, options);
  try {
    if (renderer.imagesToResolve().length !== 0) throw new Error("Raster source contains unresolved images.");
    const image = renderer.render();
    try {
      const rgba8 = new Uint8Array(image.pixels), pngBytes = new Uint8Array(image.asPng());
      if (image.width !== request.width || image.height !== request.height || rgba8.length !== request.width * request.height * 4) throw new Error("Renderer returned unexpected dimensions.");
      normalizeStraightAlpha(rgba8);
      if (request.alpha === "opaque") for (let index = 3; index < rgba8.length; index += 4) if (rgba8[index] !== 255) throw new Error("Opaque raster contains nonopaque pixels.");
      return Object.freeze({ width: image.width, height: image.height, rgba8, pngBytes, descriptor });
    } finally { image.free(); }
  } finally { renderer.free(); }
}
