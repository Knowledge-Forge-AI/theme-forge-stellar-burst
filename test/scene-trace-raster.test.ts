import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runSceneCli } from "../src/scene-cli.js";
import { canonicalPathData } from "../src/scene/path-canonical.js";
import { compileScene, traceRasterScene, validateScene } from "../src/scene/index.js";
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
  const plainPath = plain.value.svg.match(/ d="([^"]+)"/)?.[1];
  const compactPath = compact.value.svg.match(/ d="([^"]+)"/)?.[1];
  expect(compactPath).toBe("M0.01 -2A5 5 0 0 1 10 10l3 -4z");
  expect(canonicalPathData(compactPath!)).toBe(plainPath);
  expect(compact.value.receipt.sourceDigest).toBe(plain.value.receipt.sourceDigest);
  expect(compact.value.receipt.svgDigest).toBe("sha256:" + createHash("sha256").update(compact.value.svg).digest("hex"));
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
