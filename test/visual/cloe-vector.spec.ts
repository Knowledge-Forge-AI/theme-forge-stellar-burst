import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { runSceneCli } from "../../src/scene-cli.js";
import { rgbaPng } from "../brand/raster-test-helper.js";

async function render(page: Page, path: string, width: number, height: number) {
  const encoded = await page.evaluate(async ({ path, width, height }) => {
    const image = new Image();
    image.src = path;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let binary = "";
    for (let offset = 0; offset < pixels.length; offset += 8192) {
      binary += String.fromCharCode(...pixels.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }, { path, width, height });
  return Buffer.from(encoded, "base64");
}

type Region = readonly [number, number, number, number];
function compare(reference: Uint8Array, candidate: Uint8Array, width: number, height: number, region: Region) {
  const [left, top, right, bottom] = region.map((n, i) => Math.floor(n * (i % 2 === 0 ? width : height)));
  let absolute = 0, severe = 0, total = 0;
  for (let y = top!; y < bottom!; y += 1) {
    for (let x = left!; x < right!; x += 1) {
      const offset = (y * width + x) * 4;
      const delta = [0, 1, 2].map((c) => Math.abs(reference[offset + c]! - candidate[offset + c]!));
      absolute += (delta[0]! + delta[1]! + delta[2]!) / 3;
      if (Math.max(...delta) > 48) severe += 1;
      total += 1;
    }
  }
  return { mean: absolute / total, severe: severe / total };
}

test("Cloe mascot traces into a visually faithful editable SVG", async ({ page, browserName }, info) => {
  test.setTimeout(60_000);
  const reference = await readFile(new URL("./fixtures/cloe-research-studio.webp", import.meta.url));
  expect(createHash("sha256").update(reference).digest("hex"))
    .toBe("fbd4ff85614e9eeaa145fbc954929b0bc14f1b6c8c4efbf22a4c1991f317f78c");
  await page.route("http://cloe.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Cloe visual fixture</title>" }));
  await page.route("http://cloe.test/reference.webp", (route) =>
    route.fulfill({ contentType: "image/webp", body: reference }));
  await page.goto("http://cloe.test/");
  const input = await render(page, "/reference.webp", 1024, 1536);
  await mkdir(info.outputDir, { recursive: true });
  await writeFile(info.outputPath("reference.png"), rgbaPng(1024, 1536, input));
  let messages = "";
  const io = { stdout: (value: string) => { messages += value; }, stderr: (value: string) => { messages += value; } };
  expect(await runSceneCli(["trace-png", "reference.png", "--output", "cloe.json"], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli(["compile", "cloe.json", "--output", "cloe.svg", "--compact-paths"], info.outputDir, io), messages).toBe(0);
  const svg = await readFile(info.outputPath("cloe.svg"), "utf8");
  expect(svg).not.toMatch(/<(?:image|foreignObject|script)\b|\bhref\s*=/);
  expect(svg.match(/<path /g)?.length).toBeGreaterThan(1);
  expect(Buffer.byteLength(svg)).toBeLessThan(3_000_000);
  await page.route("http://cloe.test/cloe.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svg }));
  // The engines downsample vector and raster paint differently at fractional sizes.
  const isWebKit = browserName === "webkit";
  const displayMeanLimits = isWebKit ? { full: 8.5, face: 13, tablet: 9.6 } : { full: 5.6, face: 8, tablet: 6 };
  for (const width of [384, 336, 256, 512]) {
    const meanLimits = width === 512 ? { full: 7, face: 10.5, tablet: 8 } : displayMeanLimits;
    const severeLimit = isWebKit || width === 512 ? 0.065 : 0.015;
    const height = width * 1.5;
    const before = await render(page, "/reference.webp", width, height);
    const after = await render(page, "/cloe.svg", width, height);
    // A blank render must fail the same whole-image comparator.
    const blank = compare(before, Buffer.alloc(before.length, 255), width, height, [0, 0, 1, 1]);
    expect(blank.mean).toBeGreaterThan(meanLimits.full);
    const results = {
      full: compare(before, after, width, height, [0, 0, 1, 1]),
      face: compare(before, after, width, height, [0.33, 0.045, 0.64, 0.225]),
      tablet: compare(before, after, width, height, [0.64, 0.20, 0.83, 0.34]),
    };
    await info.attach(`pixel-errors-${width}.json`, { body: JSON.stringify(results), contentType: "application/json" });
    for (const region of ["full", "face", "tablet"] as const) {
      expect(results[region].mean, `${width}px ${region} mean RGB error`).toBeLessThan(meanLimits[region]);
      expect(results[region].severe, `${width}px ${region} large-error rate`).toBeLessThan(severeLimit);
    }
  }
});
