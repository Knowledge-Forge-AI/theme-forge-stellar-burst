import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runSceneCli } from "../src/scene-cli.js";
import { validateCanonicalSceneSvg } from "../src/scene/import-svg.js";
import { canonicalPathData } from "../src/scene/path-canonical.js";
import { canonicalizeScene, compileScene, traceRasterScene, validateScene } from "../src/scene/index.js";
import { rgbaPng } from "./brand/raster-test-helper.js";

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

test("omits detail cells inside a native polygon while keeping the underpaint", () => {
  const width = 32, height = 1536;
  const rgba8 = new Uint8Array(width * height * 4).fill(255);
  for (const x of [12, 25]) rgba8.set([208, 16, 16, 255], (10 * width + x) * 4);
  const source = { width, height, rgba8 };
  const before = traceRasterScene(source, { nativeDetail: true });
  const after = traceRasterScene(source, {
    nativeDetail: true, excludeDetail: [[11, 9], [15, 9], [15, 12], [11, 12]],
  });
  const underpaint = (scene: typeof before) => scene.elements.filter(e => !e.id?.startsWith("trace-detail-"));
  expect(underpaint(after)).toEqual(underpaint(before));
  const red = after.elements.find(e => e.id?.startsWith("trace-detail-") &&
    e.presentation?.fill?.type === "solid" && e.presentation.fill.color === "#d01010");
  expect(red).toMatchObject({ type: "path", d: "M25 10h1v1H25" });
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
  expect(group.children.some(element => element.id?.startsWith("trace-alpha-underpaint-"))).toBe(true);
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
    expect(JSON.parse(stdout).diagnostics[0].code).toBe("SCENE_RASTER_TRACE_REJECTED");
    await expect(readFile(join(cwd, "alpha.json"))).rejects.toThrow();
    expect(await runSceneCli([...args, "--preserve-alpha", "--exclude-detail", "cut.json"], cwd, io)).toBe(1);
    expect(JSON.parse(stdout).diagnostics[0].code).toBe("USAGE_ERROR");
    expect(await runSceneCli([...args, "--preserve-alpha"], cwd, io)).toBe(0);
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
