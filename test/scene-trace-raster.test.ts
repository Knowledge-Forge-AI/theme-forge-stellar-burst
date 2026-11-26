import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runSceneCli } from "../src/scene-cli.js";
import { canonicalizeSceneRevision } from "../src/scene/compile.js";
import { SCENE_LIMITS } from "../src/scene/constants.js";
import { validateCanonicalSceneSvg } from "../src/scene/import-svg.js";
import { canonicalPathData } from "../src/scene/path-canonical.js";
import { canonicalizeScene, compileScene, traceRasterScene, validateScene } from "../src/scene/index.js";
import { rgbaPng } from "./brand/raster-test-helper.js";
import type { SceneElement } from "../src/scene/types.js";

function allTraceElements(elements: readonly SceneElement[]): SceneElement[] {
  return elements.flatMap(element => element.type === "group"
    ? [element, ...allTraceElements(element.children)] : [element]);
}

const fineAlphaOptions = { nativeDetail: true, preserveAlpha: true, fineAlpha: true };

test.each([
  { name: "opaque", width: 4, height: 4, options: {}, json: "12b61a80810e39c86a3be4e576fc6a6e1033a672d9b97a45b36fc7c938a5a4d5", svg: "920397304b8b3220139cf95d04af9be0d53f8ae11595283243cacf18af7fac06" },
  { name: "transparent", width: 4, height: 4, options: { preserveAlpha: true }, json: "65de70f9645d98b793a71d6eacadd453af2d48f7b9ac8a3da049cb7ac84df249", svg: "fa8660a04e4f951583a1c185b248423647d2c675ecbac93196f67d8a74c15df2" },
  { name: "native underpaint", width: 16, height: 600, options: { preserveAlpha: true, nativeDetail: true }, json: "20f658379b5e483365e8ef729462257fe6f2e5e7f7f99a5dbbe29dc9fa4972a3", svg: "09bac630ed4c32206bcf603c4442c553ecb5dd8772da36fd52c54a5d4e3e1884" },
  { name: "reservation", width: 4, height: 4, options: { preserveAlpha: true, nativeDetail: true, reserveElements: 1998 }, json: "65de70f9645d98b793a71d6eacadd453af2d48f7b9ac8a3da049cb7ac84df249", svg: "fa8660a04e4f951583a1c185b248423647d2c675ecbac93196f67d8a74c15df2" },
])("pins pre-fine-alpha JSON and SVG bytes for $name", ({ width, height, options, json, svg }) => {
  const rgba8 = Uint8Array.from({ length: width * height * 4 }, (_, i) =>
    [220, 40, 20, options.preserveAlpha ? ((i >> 2) % width < width / 2 ? 128 : 253) : 255][i % 4]!);
  const scene = traceRasterScene({ width, height, rgba8 }, options);
  const compiled = compileScene(scene);
  if (!compiled.ok) throw new Error("Expected baseline compilation");
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  expect(digest(JSON.stringify(scene))).toBe(json);
  expect(digest(compiled.value.svg)).toBe(svg);
  const disabled = traceRasterScene({ width, height, rgba8 }, { ...options, fineAlpha: false });
  expect(JSON.stringify(disabled)).toBe(JSON.stringify(scene));
  expect(compileScene(disabled)).toEqual(compiled);
});

test("fine alpha requires explicit prerequisites and rejects non-boolean API values", () => {
  const source = { width: 1, height: 1, rgba8: Uint8Array.of(10, 20, 30, 255) };
  for (const options of [{ fineAlpha: true }, { fineAlpha: true, nativeDetail: true },
    { fineAlpha: true, preserveAlpha: true }]) {
    expect(() => traceRasterScene(source, options)).toThrow(/requires native detail and alpha preservation/);
  }
  for (const fineAlpha of [1, "true", null]) {
    expect(() => traceRasterScene(source, { ...fineAlphaOptions, fineAlpha: fineAlpha as unknown as boolean }))
      .toThrow(/must be a boolean/);
  }
  expect(traceRasterScene(source, { fineAlpha: false })).toEqual(traceRasterScene(source));
  expect(traceRasterScene(source, fineAlphaOptions))
    .toEqual(traceRasterScene(source, { nativeDetail: true, preserveAlpha: true }));
  expect(() => traceRasterScene(source, { ...fineAlphaOptions, reserveElements: 1 })).toThrow(/requires transparent tracing/);
  const opaque = { width: 32, height: 1536, rgba8: new Uint8Array(32 * 1536 * 4).fill(255) };
  expect(traceRasterScene(opaque, fineAlphaOptions))
    .toEqual(traceRasterScene(opaque, { nativeDetail: true, preserveAlpha: true }));
});

test("fine alpha separates low bands, skips alpha below eight and averages occupied bands", () => {
  const alphas = [0, 4, 7, 8, 11, 12, 19, 20, 119, 120, 127, 128, 135, 247, 248, 255];
  const rgba8 = Uint8Array.from(alphas.flatMap(alpha => [220, 40, 20, alpha]));
  const original = rgba8.slice();
  const source = { width: alphas.length, height: 1, rgba8 };
  const scene = traceRasterScene(source, fineAlphaOptions);
  expect(rgba8).toEqual(original);
  expect(scene.elements.map(element => element.presentation?.fillOpacity ?? 1))
    .toEqual([9.5, 15.5, 20, 119, 127.5, 247, 251.5].map(alpha => alpha / 255));
  expect(scene.elements[0]).toMatchObject({ type: "path", d: "M3 0H5V1H3" });
  const upper = { width: 7, height: 1, rgba8: rgba8.slice(9 * 4) };
  expect(traceRasterScene(upper, fineAlphaOptions))
    .toEqual(traceRasterScene(upper, { nativeDetail: true, preserveAlpha: true }));
  rgba8.set([0, 0, 0, 0], 0);
  expect(traceRasterScene(source, fineAlphaOptions)).toEqual(scene);
  rgba8.set(original);
  expect(rgba8).toEqual(original);
  const repeated = traceRasterScene(source, fineAlphaOptions);
  expect(JSON.stringify(repeated)).toBe(JSON.stringify(scene));
  const compiled = compileScene(scene);
  expect(compiled.ok).toBe(true);
  expect(compileScene(repeated)).toEqual(compiled);
  expect(rgba8).toEqual(original);
});

test("fine alpha caps low bands at fourteen colors and other partial bands at thirty-two", () => {
  const width = 64, height = 2;
  const rgba8 = Uint8Array.from({ length: width * height * 4 }, (_, i) => {
    const x = (i >> 2) % width, y = Math.floor((i >> 2) / width);
    return [x * 4, 128, 64, y === 0 ? 8 : 128][i % 4]!;
  });
  const scene = traceRasterScene({ width, height, rgba8 }, fineAlphaOptions);
  expect(scene.elements.filter(element => element.presentation?.fillOpacity === 8 / 255)).toHaveLength(14);
  expect(scene.elements.filter(element => element.presentation?.fillOpacity === 128 / 255)).toHaveLength(32);
  expect(validateScene(scene).ok).toBe(true);
  expect(compileScene(scene).ok).toBe(true);
});

test("fine alpha keeps premultiplied sampling independent of hidden RGB on a reduced grid", () => {
  const width = 3072, height = 1;
  const rgba8 = Uint8Array.from({ length: width * 4 }, (_, i) =>
    ((i >> 2) % 2 === 0 ? [0, 255, 0, 0] : [220, 40, 20, 128])[i % 4]!);
  const scene = traceRasterScene({ width, height, rgba8 }, fineAlphaOptions);
  for (let x = 0; x < width; x += 2) rgba8.set([255, 0, 255, 0], x * 4);
  expect(traceRasterScene({ width, height, rgba8 }, fineAlphaOptions)).toEqual(scene);
  expect(scene.elements).toHaveLength(1);
  expect(scene.elements[0]?.presentation).toEqual({ fill: { type: "solid", color: "#dc2814" }, fillOpacity: 64 / 255 });
  expect(scene.artboard).toEqual({ width, height, viewBox: [0, 0, 1536, 1] });
});

test("fine alpha keeps an enclosed transparent hole in its editable compound path", () => {
  const width = 5, height = 5;
  const rgba8 = Uint8Array.from({ length: width * height * 4 }, (_, i) =>
    [220, 40, 20, (i >> 2) === 12 ? 0 : 32][i % 4]!);
  const source = { width, height, rgba8 };
  const scene = traceRasterScene(source, fineAlphaOptions);
  expect(scene.elements).toHaveLength(1);
  const path = scene.elements[0];
  if (path?.type !== "path") throw new Error("Expected compound path");
  expect(path.d.match(/[Mm]/g)).toHaveLength(2);
  expect(path.presentation?.fillOpacity).toBe(32 / 255);
  rgba8.set([0, 255, 0, 0], 12 * 4);
  expect(traceRasterScene(source, fineAlphaOptions)).toEqual(scene);
  expect(compileScene(scene).ok).toBe(true);
});

test.each([253, 255])("fine alpha reserves paint and a group before native detail (near-opaque alpha %s)", alpha => {
  const width = 64, height = 600, reserveElements = 500;
  const rgba8 = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = ((x >> 1) + (y >> 1) * (width >> 1)) % 2048;
      rgba8.set([16 * (color >> 7) + 4, 16 * ((color >> 3) & 15) + 4, 32 * (color & 7) + 4, y === 0 ? 8 : alpha], (y * width + x) * 4);
    }
  }
  const source = { width, height, rgba8 };
  const scene = traceRasterScene(source, { ...fineAlphaOptions, reserveElements });
  const elements = allTraceElements(scene.elements);
  const detail = elements.filter(element => /^trace-alpha-\d+$/.test(element.id ?? ""));
  expect(detail).toHaveLength(1388);
  expect(detail.filter(element => element.presentation?.fillOpacity === 8 / 255)).toHaveLength(14);
  const coarse = elements.filter(element => element.id?.startsWith("trace-alpha-underpaint-"));
  const fine = elements.filter(element => element.id?.startsWith("trace-alpha-fine-underpaint-"));
  expect(coarse.length).toBeGreaterThan(0);
  expect(coarse.length).toBeLessThanOrEqual(64);
  expect(fine.length).toBeGreaterThan(0);
  expect(fine.length).toBeLessThanOrEqual(47);
  expect(elements.length).toBeLessThanOrEqual(2000 - reserveElements);
  expect(scene.artboard).toEqual({ width, height, viewBox: [0, 0, width, height] });
  const group = scene.elements.find(element => element.type === "group");
  if (alpha === 255) expect(group).toBeUndefined();
  else {
    expect(group).toMatchObject({ id: "trace-near-opaque", presentation: { opacity: alpha / 255 } });
    if (group?.type !== "group") throw new Error("Expected near-opaque group");
    expect(group.children.every(element => element.presentation?.fillOpacity === undefined)).toBe(true);
  }
  const validation = validateScene(scene);
  expect(validation.ok).toBe(true);
  if (!validation.ok) throw new Error("Expected bounded fine alpha trace");
  expect(validation.value.metrics.authoredElementCount).toBe(elements.length);
  const compiled = compileScene(scene);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error("Expected compiled fine alpha trace");
  expect(Buffer.byteLength(compiled.value.svg)).toBeLessThanOrEqual(16_000_000);
  expect(validateCanonicalSceneSvg(Buffer.from(compiled.value.svg), false).classification).toBe("SUPPORTED_IMPORT");
});

test("fine alpha retries a real reservation limit while retaining eligible coarse paint and the full canvas", () => {
  const width = 32, height = 1536;
  const rgba8 = Uint8Array.from({ length: width * height * 4 }, (_, i) => [220, 40, 20, 253][i % 4]!);
  const source = { width, height, rgba8 };
  const native = traceRasterScene(source, fineAlphaOptions);
  expect(allTraceElements(native.elements).some(element => element.id?.startsWith("trace-alpha-fine-underpaint-"))).toBe(true);
  // B=100 cannot hold the fixed native-large reserve of 112; B=65 can
  // never hold the coarse reserve and one detail color at reduced sizes.
  const retried = traceRasterScene(source, { ...fineAlphaOptions, reserveElements: 1900 });
  expect(retried.artboard).toEqual({ width, height, viewBox: [0, 0, 24, 1152] });
  expect(allTraceElements(retried.elements).some(element => element.id?.startsWith("trace-alpha-underpaint-"))).toBe(true);
  expect(allTraceElements(retried.elements).length).toBeLessThanOrEqual(100);
  expect(compileScene(retried).ok).toBe(true);
  for (const reserveElements of [1935, 1999]) {
    expect(() => traceRasterScene(source, { ...fineAlphaOptions, reserveElements })).toThrow(/scene limits/);
  }
  expect(traceRasterScene(source, { nativeDetail: true, preserveAlpha: true, reserveElements: 1999 }).elements)
    .toHaveLength(1);
});

test("fine alpha checks fine-grid eligibility independently of coarse paint", () => {
  const width = 8, height = 600;
  const rgba8 = Uint8Array.from({ length: width * height * 4 }, (_, i) =>
    [220, 40, 20, (i >> 2) % width === 0 || (i >> 2) % width === 7 ? 0 : 253][i % 4]!);
  const scene = traceRasterScene({ width, height, rgba8 }, fineAlphaOptions);
  const elements = allTraceElements(scene.elements);
  expect(elements.some(element => element.id?.startsWith("trace-alpha-underpaint-"))).toBe(false);
  expect(elements.some(element => element.id?.startsWith("trace-alpha-fine-underpaint-"))).toBe(true);
  expect(compileScene(scene).ok).toBe(true);
});

test.each([3, 4])("fine alpha retries instead of discarding eligible %s-cell paint that exceeds the path limit", cell => {
  const width = cell === 3 ? 96 : 192, height = 1536;
  const rgba8 = new Uint8Array(width * height * 4);
  let seed = 42;
  const offset = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 16) % 97 - 48;
  };
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      const center = (x / cell + y / cell) % 2 === 0 ? 112 : 140;
      // Tiles average to two alternating colors while distributing detail
      // among many colors. Fine (3) or coarse (4) compound paint paths exceed
      // 65,536 bytes even though the native detail fits.
      const channels = Array.from({ length: 3 }, () => Array.from({ length: cell === 3 ? 3 : 8 }, () => {
        const a = offset();
        if (cell === 4) return [-a, a];
        const b = offset();
        return [-a, -b, a + b];
      }).flat());
      for (let i = 0; i < cell * cell; i++) {
        rgba8.set([center + channels[0]![i]!, center + channels[1]![i]!, center + channels[2]![i]!, 253],
          ((y + Math.floor(i / cell)) * width + x + i % cell) * 4);
      }
    }
  }
  const source = { width, height, rgba8 };
  const legacy = traceRasterScene(source, { nativeDetail: true, preserveAlpha: true });
  expect(legacy.artboard.viewBox).toEqual([0, 0, width, height]);
  expect(allTraceElements(legacy.elements).some(element => element.id?.startsWith("trace-alpha-underpaint-"))).toBe(cell === 3);
  expect(allTraceElements(legacy.elements).some(element => element.id?.startsWith("trace-alpha-fine-underpaint-"))).toBe(false);
  const scene = traceRasterScene(source, fineAlphaOptions);
  expect(scene.artboard).toEqual({ width, height, viewBox: [0, 0, width * 0.75, 1152] });
  expect(allTraceElements(scene.elements).some(element => element.id?.startsWith("trace-alpha-underpaint-"))).toBe(true);
  expect(compileScene(scene).ok).toBe(true);
});

test.each([2, 600])("fine alpha permits detail-only when paint is genuinely ineligible (height %s)", height => {
  const width = 2;
  const rgba8 = Uint8Array.from({ length: width * height * 4 }, (_, i) =>
    [220, 40, 20, (i >> 2) % 2 === 0 ? 0 : 253][i % 4]!);
  const scene = traceRasterScene({ width, height, rgba8 }, fineAlphaOptions);
  expect(scene.elements).toHaveLength(1);
  expect(scene.elements[0]?.id).toBe("trace-alpha-0");
  expect(compileScene(scene).ok).toBe(true);
});

test("traces holes and point-touching contours into a deterministic editable scene", () => {
  const rows = ["1110", "1010", "1110", "0001"];
  const rgba8 = Uint8Array.from(rows.join("").split("").flatMap((value) =>
    value === "1" ? [208, 16, 16, 255] : [32, 40, 48, 255]));
  const input = { width: 4, height: 4, rgba8 };
  const scene = traceRasterScene(input);
  expect(traceRasterScene(input)).toEqual(scene);
  expect(scene.elements).toHaveLength(2);
  expect(scene.elements[0]).toMatchObject({ type: "path" });
  const red = scene.elements.find((element) => element.presentation?.fill?.type === "solid"
    && element.presentation.fill.color === "#d01010");
  expect(red?.type === "path" && red.d.match(/M/g)).toHaveLength(3);
  expect(compileScene(JSON.parse(JSON.stringify(scene))).ok).toBe(true);
});

test("encodes a short relative move from the previous closed contour's start", () => {
  const width = 128;
  const height = 14;
  const rgba8 = new Uint8Array(width * height * 4).fill(255);
  for (const x of [100, 103]) rgba8.set([208, 16, 16, 255], (10 * width + x) * 4);
  const scene = traceRasterScene({ width, height, rgba8 });
  const red = scene.elements.find((element) => element.id?.startsWith("trace-detail-")
    && element.presentation?.fill?.type === "solid" && element.presentation.fill.color === "#d01010");
  expect(red).toMatchObject({ type: "path", d: "M100 10h1v1h-1Zm3 0h1v1h-1Z" });
  expect(compileScene(scene, { compactPaths: true }).ok).toBe(true);
});

test("uses the previous endpoint for a relative move between filled native contours", () => {
  const width = 32;
  const height = 1536;
  const rgba8 = new Uint8Array(width * height * 4).fill(255);
  for (const x of [12, 15]) rgba8.set([208, 16, 16, 255], (10 * width + x) * 4);
  const scene = traceRasterScene({ width, height, rgba8 }, { nativeDetail: true });
  expect(scene.artboard.viewBox).toEqual([0, 0, width, height]);
  const red = scene.elements.find((element) => element.id?.startsWith("trace-detail-")
    && element.presentation?.fill?.type === "solid" && element.presentation.fill.color === "#d01010");
  expect(red).toMatchObject({ type: "path", d: "M12 10h1v1H12m3 -1h1v1H15" });
  expect(compileScene(scene).ok).toBe(true);
});

test.each([
  { orientation: "horizontal", pixels: [20, 24, 140, 144], colors: ["#161616", "#8e8e8e"] },
  { orientation: "vertical", pixels: [20, 140, 24, 144], colors: ["#161616", "#8e8e8e"] },
  { orientation: "diagonal", pixels: [20, 140, 144, 24], colors: ["#141414", "#181818", "#8c8c8c", "#909090"] },
])("adapts native samples to a $orientation edge without averaging across it", ({ pixels, colors }) => {
  const width = 32;
  const height = 1536;
  const rgba8 = new Uint8Array(width * height * 4).fill(255);
  pixels.forEach((value, index) => {
    const x = 8 + index % 2, y = 10 + Math.floor(index / 2);
    rgba8.set([value, value, value, 255], (y * width + x) * 4);
  });
  const scene = traceRasterScene({ width, height, rgba8 }, { nativeDetail: true });
  const detailColors = scene.elements
    .filter(({ id }) => id?.startsWith("trace-detail-"))
    .map(({ presentation }) => presentation?.fill)
    .filter((fill) => fill?.type === "solid")
    .map((fill) => fill.color);
  expect(detailColors.sort()).toEqual([...colors, "#ffffff"].sort());
});

test("covers the native retouch polygon with an editable patch and preserves every original path", () => {
  const width = 32, height = 1536;
  const rgba8 = new Uint8Array(width * height * 4).fill(255);
  for (const x of [12, 25]) rgba8.set([208, 16, 16, 255], (10 * width + x) * 4);
  const source = { width, height, rgba8 };
  const before = traceRasterScene(source, { nativeDetail: true });
  const after = traceRasterScene(source, {
    nativeDetail: true, excludeDetail: [[11, 9], [15, 9], [15, 12], [11, 12]],
  });
  expect(after.elements.slice(0, before.elements.length)).toEqual(before.elements);
  expect(after.elements.slice(before.elements.length)).toEqual([
    { type: "path", id: "trace-edit-underpaint-0", d: "M12 9h3v3H12", presentation: { fill: { type: "solid", color: "#fcf0f0" } } },
    { type: "path", id: "trace-edit-underpaint-1", d: "M11 9h1v3H11", presentation: { fill: { type: "solid", color: "#ffffff" } } },
  ]);
});

test.each([
  [[0, 0], [0, 2], [2, 2], [2, 0]],
  [[0, 0], [2, 2], [0, 2], [2, 0]],
  [[0, 0], [33, 0], [0, 2]],
  [[0, 0], [0.5, 0], [0, 2]],
  [[0, 0], [0, 0], [0, 2]],
].map(points => [points] as const))("rejects invalid detail polygons before tracing %#", (excludeDetail) => {
  const rgba8 = new Uint8Array(32 * 1536 * 4).fill(255);
  expect(() => traceRasterScene({ width: 32, height: 1536, rgba8 }, { nativeDetail: true, excludeDetail })).toThrow(/Detail exclusion/);
});

test("compacts validated path spacing without changing geometry or source identity", () => {
  const scene = traceRasterScene({ width: 1, height: 1, rgba8: Uint8Array.of(10, 20, 30, 255) });
  const input = {
    ...scene,
    elements: [{ type: "group", id: "nested", children: [{
      type: "path", id: "mixed", d: "M1e-2 -2A5 5 0 0 1 10 10l3 -4z",
    }] }],
  };
  const plain = compileScene(input);
  const compact = compileScene(input, { compactPaths: true });
  if (!plain.ok || !compact.ok) throw new Error("Expected valid scene");
  const stable = canonicalizeScene(input, { fitInput: true });
  if (!stable.ok) throw new Error("Expected canonical scene");
  expect(compileScene(input, { fitInput: true })).toEqual({
    ok: true, value: { ...plain.value, canonicalJson: stable.value },
  });
  expect(plain.value.receipt.sourceDigest).toBe("sha256:" + createHash("sha256").update(stable.value).digest("hex"));
  const plainPath = plain.value.svg.match(/ d="([^"]+)"/)?.[1];
  const compactPath = compact.value.svg.match(/ d="([^"]+)"/)?.[1];
  expect(compactPath).toBe("M0.01 -2A5 5 0 0 1 10 10l3 -4z");
  expect(canonicalPathData(compactPath!)).toBe(plainPath);
  expect(compact.value.receipt.sourceDigest).toBe(plain.value.receipt.sourceDigest);
  expect(compact.value.receipt.svgDigest).toBe("sha256:" + createHash("sha256").update(compact.value.svg).digest("hex"));
});

test("binds the compile receipt to compact editable JSON while preserving the full SVG", () => {
  const base = traceRasterScene({ width: 1, height: 1, rgba8: Uint8Array.of(10, 20, 30, 255) });
  const d = "M0 0" + "l0.123 0.123".repeat(4_000);
  const scene = {
    ...base,
    elements: Array.from({ length: 166 }, () => ({ type: "path", d })),
  };
  const inputLimit = 8 * 1024 * 1024;
  const expanded = canonicalizeScene(scene);
  const editable = canonicalizeScene(scene, { fitInput: true });
  if (!expanded.ok || !editable.ok) throw new Error("Expected canonical scene");
  expect(Buffer.byteLength(expanded.value)).toBeGreaterThan(inputLimit);
  expect(Buffer.byteLength(editable.value)).toBeLessThanOrEqual(inputLimit);

  const reopened = JSON.parse(editable.value);
  expect(canonicalizeScene(reopened, { fitInput: true })).toEqual(editable);
  const original = compileScene(scene);
  const prepared = compileScene(reopened, { fitInput: true });
  if (!original.ok || !prepared.ok) throw new Error("Expected compiled scene");
  expect(prepared.value.canonicalJson).toBe(editable.value);
  expect(prepared.value.svg).toBe(original.value.svg);
  expect(prepared.value.receipt.svgDigest).toBe(original.value.receipt.svgDigest);
  expect(prepared.value.receipt.sourceDigest).toBe("sha256:" + createHash("sha256").update(editable.value).digest("hex"));
  expect(original.value.receipt.sourceDigest).toBe("sha256:" + createHash("sha256").update(expanded.value).digest("hex"));
});

test("recovers room for a revision by compacting the existing validated paths", () => {
  const d = "M0 0" + " ".repeat(60_000);
  const scene = {
    schema: "tfsb.vector-scene-v1", compatibility: 1, compilerLevel: 1,
    profile: "diagram", artboard: { width: 10, height: 10, viewBox: [0, 0, 10, 10] },
    accessibility: { mode: "decorative" },
    elements: Array.from({ length: 138 }, () => ({ type: "path", d })),
  };
  const added = [
    { type: "path", d, id: "new-first" },
    { type: "path", d, id: "new-second" },
  ];
  expect(Buffer.byteLength(JSON.stringify(scene))).toBeLessThan(SCENE_LIMITS.maxInputBytes);
  expect(Buffer.byteLength(JSON.stringify({ ...scene, elements: [...scene.elements, ...added] })))
    .toBeGreaterThan(SCENE_LIMITS.maxInputBytes);
  const revised = canonicalizeSceneRevision(scene, current => ({
    ...current,
    elements: [...current.elements, ...added],
  }));
  if (!revised.ok) throw new Error(revised.diagnostics[0]?.message);
  const expected = compileScene({
    ...scene, elements: [...scene.elements, ...added].map(element => ({ ...element, d: "M0 0" })),
  });
  expect(compileScene(JSON.parse(revised.value))).toEqual(expected);
  expect(scene.elements[0]?.d).toBe(d);
});

test("retains room for a desktop edit when fitting a dense editable scene", () => {
  const base = traceRasterScene({ width: 1, height: 1, rgba8: Uint8Array.of(10, 20, 30, 255) });
  const path = { type: "path", d: "M0 0" + "l1 -1l-1 1".repeat(2000) };
  const elements = Array.from({ length: 410 }, () => path);
  const additional = Array.from({ length: 10 }, () => path);
  const scene = { ...base, elements };
  const cap = 8 * 1024 * 1024;
  expect(Buffer.byteLength(JSON.stringify(scene))).toBeLessThan(cap);
  expect(Buffer.byteLength(JSON.stringify({ ...scene, elements: [...elements, ...additional] }))).toBeGreaterThan(cap);

  const regular = compileScene(scene);
  const fitted = compileScene(scene, { fitInput: true });
  if (!regular.ok || !fitted.ok || !fitted.value.canonicalJson) throw new Error("Fixture did not compile");
  expect(fitted.value.svg).toBe(regular.value.svg);
  expect(fitted.value.receipt.sourceDigest).toBe("sha256:" + createHash("sha256").update(fitted.value.canonicalJson).digest("hex"));
  const editable = JSON.parse(fitted.value.canonicalJson);
  const draft = { ...editable, elements: [...editable.elements, ...additional] };
  expect(Buffer.byteLength(JSON.stringify(draft))).toBeLessThanOrEqual(cap);
  const compiled = compileScene(draft, { fitInput: true });
  expect(compiled.ok).toBe(true);
});

test("uses fractional pixel coverage when the source does not divide into trace cells", () => {
  const rgba8 = new Uint8Array(1440 * 4);
  for (let x = 0; x < 1440; x += 1) {
    const gray = x % 2 === 0 ? 0 : 240;
    rgba8.set([gray, gray, gray, 255], x * 4);
  }
  const scene = traceRasterScene({ width: 1440, height: 1, rgba8 });
  expect(scene.artboard.viewBox).toEqual([0, 0, 576, 1]);
  expect(new Set(scene.elements.map((element) => {
    const fill = element.presentation?.fill;
    return fill?.type === "solid" ? fill.color : undefined;
  }))).toEqual(new Set(["#606060", "#909090"]));
});

test.each([
  { jitter: 16, block: 2, segments: 925_266 },
  { jitter: 24, block: 4, segments: 884_919 },
])("keeps a noisy gradient traceable using $block-by-$block underpainting", ({ jitter, block, segments }) => {
  const size = 576;
  const rgba8 = new Uint8Array(size * size * 4);
  let seed = 123;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 24) * jitter / 256;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      rgba8[offset] = x * 23 / 64 + 8 + noise();
      rgba8[offset + 1] = y * 23 / 64 + 8 + noise();
      rgba8[offset + 2] = (x + y) * 23 / 128 + 8 + noise();
      rgba8[offset + 3] = 255;
    }
  }
  const scene = traceRasterScene({ width: size, height: size, rgba8 });
  expect(scene.elements.find(({ id }) => id?.startsWith("trace-undercoat-"))?.transform)
    .toEqual([{ type: "scale", x: block }]);
  const validated = validateScene(scene);
  if (!validated.ok) throw new Error("Expected the fallback trace to stay within scene limits");
  expect(validated.value.metrics.pathSegmentCount).toBe(segments);
});

test("refuses invalid dimensions and any nonopaque sample", () => {
  expect(() => traceRasterScene({ width: 4096, height: 4096, rgba8: new Uint8Array() })).toThrow(RangeError);
  expect(() => traceRasterScene({ width: 1, height: 1, rgba8: Uint8Array.of(1, 2, 3, 0) })).toThrow(/opaque/);
});

test("preserves transparent holes and translucent paint on the original artboard by opt-in", () => {
  const rgba8 = Uint8Array.of(
    0, 255, 0, 0, 220, 40, 20, 128,
    220, 40, 20, 255, 0, 0, 255, 0,
  );
  const input = { width: 2, height: 2, rgba8 };
  const scene = traceRasterScene(input, { preserveAlpha: true, nativeDetail: true });
  expect(scene.artboard).toEqual({ width: 2, height: 2, viewBox: [0, 0, 2, 2] });
  expect(scene.elements).toHaveLength(2);
  expect(scene.elements.map(({ presentation }) => presentation)).toEqual([
    { fill: { type: "solid", color: "#dc2814" }, fillOpacity: 128 / 255 },
    { fill: { type: "solid", color: "#dc2814" } },
  ]);
  const withoutHiddenRgb = rgba8.slice();
  withoutHiddenRgb.fill(0, 0, 4);
  withoutHiddenRgb.fill(0, 12, 16);
  expect(traceRasterScene({ ...input, rgba8: withoutHiddenRgb }, { preserveAlpha: true, nativeDetail: true })).toEqual(scene);
  const compiled = compileScene(scene);
  if (!compiled.ok) throw new Error("Expected an editable transparent scene");
  expect(compiled.value.svg).toContain(`fill-opacity="${128 / 255}"`);
  expect(compiled.value.svg).not.toContain("trace-base");
});

test("preserves transparent artwork's element reservation behavior", () => {
  const rgba8 = Uint8Array.of(0, 0, 0, 0, 220, 40, 20, 128, 220, 40, 20, 255, 0, 0, 0, 0);
  const input = { width: 2, height: 2, rgba8 };
  const options = { preserveAlpha: true, nativeDetail: true };
  const original = traceRasterScene(input, options);
  expect(traceRasterScene(input, { ...options, reserveElements: 1998 })).toEqual(original);
  expect(() => traceRasterScene(input, { ...options, reserveElements: 1999 })).toThrow(/scene limits/);
  expect(() => traceRasterScene(input, { ...options, reserveElements: 0 })).toThrow(/positive count/);
  expect(() => traceRasterScene({ width: 1, height: 1, rgba8: Uint8Array.of(0, 0, 0, 255) },
    { ...options, reserveElements: 1 })).toThrow(/requires transparent tracing/);
});

test("composites seam underpaint and near-opaque detail together without filling soft edges", () => {
  const width = 16, height = 16;
  const rgba8 = Uint8Array.from({ length: width * height * 4 }, (_, i) => {
    const col = (i >> 2) % width;
    return [220, 40, 20, col < 2 || col > 10 ? 0 : col === 10 ? 128 : 253][i % 4]!;
  });
  const scene = traceRasterScene({ width, height, rgba8 }, { nativeDetail: true, preserveAlpha: true });
  expect(scene.artboard.viewBox).toEqual([0, 0, width, height]);
  expect(scene.elements[0]).toMatchObject({ presentation: { fillOpacity: 128 / 255 } });
  const group = scene.elements[1];
  if (group?.type !== "group") throw new Error("Expected a near-opaque group");
  expect(group.presentation).toEqual({ opacity: 253 / 255 });
  expect(group.children).toHaveLength(2);
  expect(group.children[0]).toMatchObject({
    id: "trace-alpha-underpaint-0", d: "M1 1H2V3H1Z",
    transform: [{ type: "scale", x: 4 }],
    presentation: {
      fill: { type: "solid", color: "#dc2814" }, stroke: { type: "solid", color: "#dc2814" },
      strokeWidth: 0.5, strokeLinejoin: "bevel",
    },
  });
  expect(group.children[1]?.presentation).toEqual({ fill: { type: "solid", color: "#dc2814" } });
  const compiled = compileScene(scene);
  if (!compiled.ok) throw new Error("Expected an editable transparent scene with underpaint");
  expect(validateCanonicalSceneSvg(Buffer.from(compiled.value.svg), false).classification).toBe("SUPPORTED_IMPORT");
});

test("adds a finer underpaint inside the shared opacity group for large native traces", () => {
  const width = 32, height = 600;
  const rgba8 = Uint8Array.from({ length: width * height * 4 }, (_, i) => {
    const col = (i >> 2) % width;
    const tone = col < width / 2 ? 220 : 120;
    return [tone, 40, 20, col < 3 || col > 28 ? 0 : col === 28 ? 128 : 253][i % 4]!;
  });
  const source = { width, height, rgba8 };
  const scene = traceRasterScene(source, { nativeDetail: true, preserveAlpha: true });
  expect(scene.artboard.viewBox).toEqual([0, 0, width, height]);
  const group = scene.elements.find(element => element.id === "trace-near-opaque");
  if (group?.type !== "group") throw new Error("Expected a near-opaque group");
  expect(group.presentation).toEqual({ opacity: 253 / 255 });
  const nearLeftPaint = group.children.find(element => element.id?.startsWith("trace-alpha-underpaint-")
    && element.presentation?.fill?.type === "solid" && element.presentation.fill.color === "#dc2814");
  // The fill starts at x = 4 and the bevel reaches x = 3, the first near-opaque column.
  expect(nearLeftPaint).toMatchObject({
    type: "path", d: "M1 1H4V149H1Z", transform: [{ type: "scale", x: 4 }],
    presentation: { strokeWidth: 0.5, strokeLinejoin: "bevel" },
  });
  expect(group.children.some(element => element.id?.startsWith("trace-alpha-fine-underpaint-"))).toBe(true);
  expect(group.children.every(element => element.presentation?.fillOpacity === undefined)).toBe(true);
  const highDetail = traceRasterScene(source, { preserveAlpha: true });
  expect(JSON.stringify(highDetail)).not.toContain("trace-alpha-fine-underpaint-");
});

test("the trace CLI requires explicit opt-in before publishing a transparent source scene", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tfsb-trace-alpha-"));
  try {
    const cwd = await realpath(directory);
    await writeFile(join(cwd, "source.png"), rgbaPng(2, 1, Uint8Array.of(0, 0, 0, 0, 220, 40, 20, 128)));
    let stdout = "";
    const io = { stdout: (text: string) => { stdout = text; }, stderr: () => {} };
    const args = ["trace-png", "source.png", "--output", "alpha.json", "--native-detail", "--json"];
    expect(await runSceneCli(args, cwd, io)).toBe(1);
    expect(JSON.parse(stdout).diagnostics[0]).toMatchObject({
      code: "SCENE_RASTER_TRACE_REJECTED",
      message: expect.stringContaining("use --preserve-alpha"),
    });
    await expect(readFile(join(cwd, "alpha.json"))).rejects.toThrow();
    expect(await runSceneCli([...args, "--preserve-alpha", "--exclude-detail", "cut.json"], cwd, io)).toBe(1);
    expect(JSON.parse(stdout).diagnostics[0].code).toBe("USAGE_ERROR");
    expect(await runSceneCli([...args, "--reserve-elements", "1"], cwd, io)).toBe(1);
    expect(JSON.parse(stdout).diagnostics[0].code).toBe("USAGE_ERROR");
    for (const invalid of ["0", "1.5", "2000"]) {
      expect(await runSceneCli([...args, "--preserve-alpha", "--reserve-elements", invalid], cwd, io)).toBe(1);
      expect(JSON.parse(stdout).diagnostics[0].code).toBe("USAGE_ERROR");
    }
    await expect(readFile(join(cwd, "alpha.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runSceneCli([...args, "--preserve-alpha", "--reserve-elements", "1"], cwd, io)).toBe(0);
    const scene = JSON.parse(await readFile(join(cwd, "alpha.json"), "utf8"));
    expect(scene.elements).toHaveLength(1);
    expect(scene.elements[0].presentation.fillOpacity).toBe(128 / 255);
    expect(compileScene(scene).ok).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses malformed, animated, or oversized WebP input before publishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tfsb-trace-webp-"));
  try {
    const cwd = await realpath(directory);
    const source = await readFile(new URL("./visual/fixtures/cloe-research-studio.webp", import.meta.url));
    expect(source.toString("ascii", 12, 16)).toBe("VP8 ");
    const oversized = Buffer.from(source);
    oversized.writeUInt16LE(2049, 26);
    oversized.writeUInt16LE(2049, 28);
    const animated = Buffer.concat([source, Buffer.from([65, 78, 73, 77, 0, 0, 0, 0])]);
    animated.writeUInt32LE(animated.length - 8, 4);
    let stdout = "";
    const io = { stdout: (text: string) => { stdout = text; }, stderr: () => {} };
    for (const bytes of [source.subarray(0, -1), oversized, animated]) {
      await writeFile(join(cwd, "source.webp"), bytes);
      const args = ["trace-webp", "source.webp", "--output", "scene.json", "--native-detail", "--json"];
      expect(await runSceneCli(args, cwd, io)).toBe(1);
      expect(JSON.parse(stdout).diagnostics[0].code).toBe("SCENE_TRACE_WEBP_SOURCE_INVALID");
      await expect(readFile(join(cwd, "scene.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects dense palettes outside opaque native tracing", () => {
  const width = 32, height = 1536;
  const source = { width, height, rgba8: new Uint8Array(width * height * 4).fill(255) };
  for (const options of [
    { densePalette: true },
    { nativeDetail: true, densePalette: true, preserveAlpha: true },
  ]) {
    expect(() => traceRasterScene(source, options)).toThrow(/dense palette/i);
  }
  for (const options of [
    { nativeDetail: true, reserveElements: 125 },
    { nativeDetail: true, densePalette: true },
    { nativeDetail: true, densePalette: true, reserveElements: 125, excludeDetail: {} },
  ]) {
    expect(() => traceRasterScene(source, { ...options, underpaintOverlap: true })).toThrow(/underpaint overlap/i);
  }
  const translucent = source.rgba8.slice();
  translucent[3] = 128;
  expect(() => traceRasterScene({ ...source, rgba8: translucent }, { nativeDetail: true, densePalette: true }))
    .toThrow(/opaque/);
  expect(() => traceRasterScene({ width: 1, height: 1, rgba8: Uint8Array.of(0, 0, 0, 255) },
    { nativeDetail: true, densePalette: true })).toThrow(/supported native trace/);
});

test("retains the native grid and reserves authored elements with a dense palette", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tfsb-dense-reserve-"));
  try {
    const cwd = await realpath(directory);
    const width = 128, height = 1536;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const color = ((x >> 1) + (y >> 1) * (width >> 1)) % 2048;
        rgba.set([16 * (color >> 7) + 4, 16 * ((color >> 3) & 15) + 4, 32 * (color & 7) + 4, 255],
          (y * width + x) * 4);
      }
    }
    await writeFile(join(cwd, "source.png"), rgbaPng(width, height, rgba));
    let stdout = "";
    const io = { stdout: (text: string) => { stdout = text; }, stderr: () => {} };
    const trace = (output: string, ...options: string[]) => runSceneCli(
      ["trace-png", "source.png", "--output", output, "--json", ...options], cwd, io);
    for (const options of [
      ["--dense-palette"],
      ["--native-detail", "--dense-palette", "--preserve-alpha"],
      ["--native-detail", "--dense-palette", "--dense-palette"],
      ["--native-detail", "--reserve-elements", "125"],
      ["--native-detail", "--underpaint-overlap"],
      ["--native-detail", "--dense-palette", "--underpaint-overlap"],
      ["--native-detail", "--dense-palette", "--reserve-elements", "125", "--underpaint-overlap", "--underpaint-overlap"],
      ["--native-detail", "--dense-palette", "--reserve-elements", "125", "--underpaint-overlap", "--exclude-detail", "unused.json"],
    ]) {
      expect(await trace("refused.json", ...options)).toBe(1);
      expect(JSON.parse(stdout).diagnostics[0].code).toBe("USAGE_ERROR");
      await expect(readFile(join(cwd, "refused.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await trace("default.json", "--native-detail"), stdout).toBe(0);
    expect(await trace("dense.json", "--native-detail", "--dense-palette"), stdout).toBe(0);
    expect(await trace("reserved.json", "--native-detail", "--dense-palette", "--reserve-elements", "125"), stdout).toBe(0);
    const metrics = JSON.parse(stdout).data.metrics;
    expect(metrics.authoredElementCount).toBeLessThanOrEqual(SCENE_LIMITS.maxAuthoredElements - 125);
    async function load(name: string): Promise<ReturnType<typeof traceRasterScene>> {
      return JSON.parse(await readFile(join(cwd, name), "utf8"));
    }
    const regular = await load("default.json");
    const dense = await load("dense.json");
    const reserved = await load("reserved.json");
    const detailCount = (scene: typeof dense) => scene.elements.filter(
      ({ id }) => id?.startsWith("trace-detail-")).length;
    expect(detailCount(regular)).toBe(1664);
    expect(detailCount(dense)).toBe(1856);
    expect(detailCount(reserved)).toBe(1778);
    const paint = (scene: typeof dense) => scene.elements.filter(
      ({ id }) => id?.startsWith("trace-undercoat-"));
    expect(paint(reserved)).toHaveLength(96);
    for (const path of paint(reserved)) {
      if (path.type !== "path") throw new Error("Expected an undercoat path");
      expect(path.presentation?.stroke).toBeUndefined();
      expect(path.transform).toEqual([{ type: "scale", x: 4 }]);
    }
    expect([...paint(regular), ...paint(dense)].every(path => path.presentation?.stroke === undefined)).toBe(true);
    expect(reserved.artboard).toEqual(dense.artboard);
    expect(reserved.elements.length).toBe(metrics.authoredElementCount);

    expect(await trace("repeated.json", "--native-detail", "--dense-palette", "--reserve-elements", "125"), stdout).toBe(0);
    expect(await readFile(join(cwd, "repeated.json"), "utf8")).toBe(await readFile(join(cwd, "reserved.json"), "utf8"));
    expect(await trace("overlap.json", "--native-detail", "--dense-palette", "--reserve-elements", "125", "--underpaint-overlap"), stdout).toBe(0);
    const overlap = await load("overlap.json");
    expect(overlap.artboard).toEqual(reserved.artboard);
    expect(overlap.elements.map(({ id }) => id)).toEqual(reserved.elements.map(({ id }) => id));
    expect(paint(overlap)).toHaveLength(96);
    for (const path of paint(overlap)) {
      if (path.type !== "path") throw new Error("Expected an undercoat path");
      expect(path.presentation?.stroke).toEqual(path.presentation?.fill);
      expect(path.presentation?.strokeWidth).toBe(0.125);
      expect(path.presentation?.strokeLinejoin).toBe("bevel");
      expect(path.d).toMatch(/^(?:[Mm][^MmZ]*Z)+$/u);
      expect(path.transform).toEqual([{ type: "scale", x: 4 }]);
    }
    const compiledOverlap = compileScene(overlap);
    if (!compiledOverlap.ok) throw new Error("Expected a compiled dense overlap scene");
    expect(Buffer.byteLength(compiledOverlap.value.svg)).toBeLessThanOrEqual(16_000_000);

    const compiled = compileScene(reserved);
    if (!compiled.ok) throw new Error("Expected a compiled dense reserved scene");
    const canonical = canonicalizeScene(reserved);
    if (!canonical.ok) throw new Error("Expected a canonical dense reserved scene");
    expect(compileScene(await load("repeated.json"))).toEqual(compiled);
    expect(compileScene(JSON.parse(canonical.value))).toEqual(compiled);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("admits one dense detail color at the reserve cutoff and refuses an empty palette without output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tfsb-dense-cutoff-"));
  try {
    const cwd = await realpath(directory);
    const width = 32, height = 1536;
    await writeFile(join(cwd, "source.png"), rgbaPng(width, height, new Uint8Array(width * height * 4).fill(255)));
    let stdout = "";
    const io = { stdout: (text: string) => { stdout = text; }, stderr: () => {} };
    const trace = (reserve: number) => runSceneCli([
      "trace-png", "source.png", "--output", `reserve-${reserve}.json`, "--native-detail", "--dense-palette",
      "--reserve-elements", String(reserve), "--json",
    ], cwd, io);
    expect(await trace(1902), stdout).toBe(0);
    const scene: ReturnType<typeof traceRasterScene> = JSON.parse(await readFile(join(cwd, "reserve-1902.json"), "utf8"));
    expect(scene.artboard.viewBox).toEqual([0, 0, width, height]);
    expect(scene.elements.filter(({ id }) => id?.startsWith("trace-detail-"))).toHaveLength(1);
    expect(scene.elements.length).toBeLessThanOrEqual(SCENE_LIMITS.maxAuthoredElements - 1902);
    expect(compileScene(scene).ok).toBe(true);
    for (const reserve of [1903, 1999]) {
      expect(await trace(reserve)).toBe(1);
      expect(JSON.parse(stdout).diagnostics[0].code).toBe("SCENE_RASTER_TRACE_REJECTED");
      await expect(readFile(join(cwd, `reserve-${reserve}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("counts the dense exclusion layer before assigning the remaining palette slots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tfsb-dense-exclusion-"));
  try {
    const cwd = await realpath(directory);
    const width = 32, height = 1536;
    await writeFile(join(cwd, "source.png"), rgbaPng(width, height, new Uint8Array(width * height * 4).fill(255)));
    await writeFile(join(cwd, "polygon.json"), JSON.stringify([[11, 9], [15, 9], [15, 12], [11, 12]]));
    let stdout = "";
    const io = { stdout: (text: string) => { stdout = text; }, stderr: () => {} };
    const trace = (reserve: number, output: string) => runSceneCli([
      "trace-png", "source.png", "--native-detail", "--dense-palette", "--exclude-detail", "polygon.json",
      "--reserve-elements", String(reserve), "--output", output, "--json",
    ], cwd, io);

    expect(await trace(1996, "exact.json"), stdout).toBe(0);
    const scene: ReturnType<typeof traceRasterScene> = JSON.parse(await readFile(join(cwd, "exact.json"), "utf8"));
    expect(scene.artboard.viewBox).toEqual([0, 0, width, height]);
    expect(scene.elements.map(element => element.id)).toEqual([
      "trace-base", "trace-undercoat-0", "trace-detail-0", "trace-edit-underpaint-0",
    ]);
    expect(compileScene(scene).ok).toBe(true);
    expect(await trace(1996, "repeat.json"), stdout).toBe(0);
    expect(await readFile(join(cwd, "repeat.json"), "utf8")).toBe(await readFile(join(cwd, "exact.json"), "utf8"));

    expect(await trace(1997, "refused.json")).toBe(1);
    expect(JSON.parse(stdout).diagnostics[0].code).toBe("SCENE_RASTER_TRACE_REJECTED");
    await expect(readFile(join(cwd, "refused.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["png", "webp"] as const)("budgets multicolor dense exclusions on unequal axes through trace-%s", async (format) => {
  const directory = await mkdtemp(join(tmpdir(), "tfsb-dense-exclusion-colors-"));
  try {
    const cwd = await realpath(directory);
    const width = 22, height = 1536;
    const rgba8 = new Uint8Array(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < 4; x++) rgba8.set([208, 16, 16, 255], (y * width + x) * 4);
    }
    // Lossless WebP of the same 22 x 1536 red stripe on opaque white.
    const webp = Buffer.from("UklGRiwAAABXRUJQVlA4TB8AAAAvFcB/AQ/wiP9H/z/if/7jAUICwgP/Z0si+h/C/tcHAA==", "base64");
    const polygon = [[2, 9], [10, 9], [10, 12], [2, 12]];
    await writeFile(join(cwd, `source.${format}`), format === "png" ? rgbaPng(width, height, rgba8) : webp);
    await writeFile(join(cwd, "polygon.json"), JSON.stringify(polygon));
    let stdout = "";
    const io = { stdout: (text: string) => { stdout = text; }, stderr: () => {} };
    const trace = (output: string, ...flags: string[]) => runSceneCli([
      `trace-${format}`, `source.${format}`, "--native-detail", "--dense-palette", "--exclude-detail", "polygon.json",
      "--output", output, "--json", ...flags,
    ], cwd, io);
    const load = async (output: string): Promise<ReturnType<typeof traceRasterScene>> =>
      JSON.parse(await readFile(join(cwd, output), "utf8"));

    // Three undercoat colors, all present in the polygon, leave one detail slot at B = 8.
    expect(await trace("exact.json", "--reserve-elements", "1992"), stdout).toBe(0);
    const scene = await load("exact.json");
    expect(scene.artboard.viewBox).toEqual([0, 0, width, height]);
    expect(scene.elements).toHaveLength(8);
    const undercoat = scene.elements.filter(({ id }) => id?.startsWith("trace-undercoat-"));
    expect(undercoat).toHaveLength(3);
    for (const path of undercoat) expect(path.transform).toEqual([{ type: "scale", x: 22 / 6, y: 4 }]);
    expect(scene.elements.filter(({ id }) => id?.startsWith("trace-detail-"))).toHaveLength(1);
    const overlay = scene.elements.filter(({ id }) => id?.startsWith("trace-edit-underpaint-"));
    expect(overlay).toHaveLength(3);
    expect(overlay.map(path => path.type === "path" && path.d).sort()).toEqual([
      "M2 9H4v3H2", "M4 9H7v3H4", "M7 9h3v3H7",
    ]);
    const exclusionOnly = traceRasterScene({ width, height, rgba8 }, { nativeDetail: true, excludeDetail: polygon });
    expect(overlay).toEqual(exclusionOnly.elements.filter(({ id }) => id?.startsWith("trace-edit-underpaint-")));
    const samePalette = traceRasterScene({ width, height, rgba8 }, {
      nativeDetail: true, densePalette: true, reserveElements: 1902,
    });
    expect(scene.elements.slice(0, samePalette.elements.length)).toEqual(samePalette.elements);
    expect(compileScene(scene).ok).toBe(true);
    expect(await trace("repeat.json", "--reserve-elements", "1992"), stdout).toBe(0);
    expect(await readFile(join(cwd, "repeat.json"), "utf8")).toBe(await readFile(join(cwd, "exact.json"), "utf8"));

    expect(await trace("refused.json", "--reserve-elements", "1993")).toBe(1);
    expect(JSON.parse(stdout).diagnostics[0].code).toBe("SCENE_RASTER_TRACE_REJECTED");
    await expect(readFile(join(cwd, "refused.json"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const flags of [
      ["0"], ["-1"], ["1.5"], ["invalid"], ["2000"], ["125", "--reserve-elements", "125"],
    ]) {
      expect(await trace("invalid.json", "--reserve-elements", ...flags)).toBe(1);
      expect(JSON.parse(stdout).diagnostics[0].code).toBe("USAGE_ERROR");
      await expect(readFile(join(cwd, "invalid.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await trace("unreserved.json"), stdout).toBe(0);
    const unreserved = await load("unreserved.json");
    const denseOnly = traceRasterScene({ width, height, rgba8 }, { nativeDetail: true, densePalette: true });
    expect(unreserved.elements.slice(0, denseOnly.elements.length)).toEqual(denseOnly.elements);
    expect(unreserved.elements.slice(denseOnly.elements.length)).toEqual(overlay);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a detail exclusion without a matching native grid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tfsb-trace-png-"));
  try {
    const cwd = await realpath(directory);
    await writeFile(join(cwd, "source.png"), rgbaPng(4, 4, new Uint8Array(4 * 4 * 4).fill(255)));
    await writeFile(join(cwd, "polygon.json"), JSON.stringify([[0, 0], [3, 0], [3, 3], [0, 3]]));
    const args = ["trace-png", "source.png", "--exclude-detail", "polygon.json", "--output", "out.json", "--json"];
    let stdout = "";
    const io = { stdout: (text: string) => { stdout = text; }, stderr: () => {} };
    expect(await runSceneCli(args, cwd, io)).toBe(1);
    expect(JSON.parse(stdout).diagnostics[0].code).toBe("USAGE_ERROR");
    expect(await runSceneCli([...args, "--native-detail"], cwd, io)).toBe(1);
    expect(JSON.parse(stdout).diagnostics[0].code).toBe("SCENE_RASTER_TRACE_REJECTED");
    await expect(readFile(join(cwd, "out.json"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("traces a supported PNG through the CLI, refuses overwrites and rejects non-PNG input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tfsb-trace-png-"));
  try {
    const cwd = await realpath(directory);
    await mkdir(join(cwd, "out"));
    await writeFile(join(cwd, "source.png"), rgbaPng(2, 1, Uint8Array.of(224, 0, 0, 255, 0, 160, 0, 255)));
    await writeFile(join(cwd, "invalid.png"), "not a PNG");
    let stdout = "";
    const io = { stdout: (value: string) => { stdout += value; }, stderr: () => {} };
    const args = ["trace-png", "source.png", "--output", "out/scene.json", "--json"];
    expect(await runSceneCli(args, cwd, io)).toBe(0);
    expect(JSON.parse(stdout).data).toMatchObject({ action: "trace-png", written: true });
    const output = await readFile(join(cwd, "out/scene.json"), "utf8");
    expect(await runSceneCli(
      ["trace-png", "source.png", "--high-detail", "--output", "out/small-detail.json"], cwd, io,
    )).toBe(0);
    expect(await readFile(join(cwd, "out/small-detail.json"), "utf8")).toBe(output);
    expect(compileScene(JSON.parse(output)).ok).toBe(true);
    expect(await runSceneCli(args, cwd, io)).toBe(1);
    expect(await readFile(join(cwd, "out/scene.json"), "utf8")).toBe(output);
    stdout = "";
    expect(await runSceneCli(["trace-png", "invalid.png", "--output", "out/invalid.json", "--json"], cwd, io)).toBe(1);
    expect(JSON.parse(stdout).diagnostics[0].code).toBe("SCENE_RASTER_TRACE_REJECTED");
    expect(JSON.parse(stdout).diagnostics[0].message).not.toContain("use --preserve-alpha");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fits opaque native fills without changing the editable geometry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tfsb-source-color-fit-"));
  try {
    const cwd = await realpath(directory);
    const width = 32, height = 1536;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const band = ((x >> 1) + (y >> 1)) % 16;
        const accent = (x & 1) && (y & 1) ? 3 : 0;
        rgba.set([16 * band + accent, 40 + band, 70, 255], (y * width + x) * 4);
      }
    }
    await writeFile(join(cwd, "source.png"), rgbaPng(width, height, rgba));
    await writeFile(join(cwd, "small.png"), rgbaPng(4, 4, new Uint8Array(4 * 4 * 4).fill(255)));
    let stdout = "";
    const io = { stdout: (text: string) => { stdout = text; }, stderr: () => {} };
    async function trace(file: string, output: string, ...flags: string[]) {
      return runSceneCli(["trace-png", file, "--output", output, "--json", ...flags], cwd, io);
    }
    for (const flags of [
      ["--fit-source-colors"],
      ["--native-detail", "--fit-source-colors", "--fit-source-colors"],
      ["--native-detail", "--fit-source-colors", "--preserve-alpha"],
    ]) {
      expect(await trace("source.png", "refused.json", ...flags)).toBe(1);
      expect(JSON.parse(stdout).diagnostics[0].code).toBe("USAGE_ERROR");
    }
    expect(await trace("small.png", "refused.json", "--native-detail", "--fit-source-colors")).toBe(1);
    expect(JSON.parse(stdout).diagnostics[0].code).toBe("SCENE_RASTER_TRACE_REJECTED");
    await expect(readFile(join(cwd, "refused.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await trace("source.png", "normal.json", "--native-detail"), stdout).toBe(0);
    expect(JSON.parse(stdout).data.colorFit).toBeUndefined();
    expect(await trace("source.png", "fitted.json", "--native-detail", "--fit-source-colors"), stdout).toBe(0);
    expect(JSON.parse(stdout).data.colorFit).toBe("source-pixel-median-v1");

    const before = await readFile(join(cwd, "normal.json"), "utf8");
    const after = await readFile(join(cwd, "fitted.json"), "utf8");
    expect(after).not.toBe(before);
    const fills = /"type":"solid","color":"#[0-9a-fA-F]{6}"/gu;
    expect(after.replace(fills, "")).toBe(before.replace(fills, ""));
    expect(compileScene(JSON.parse(after)).ok).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
