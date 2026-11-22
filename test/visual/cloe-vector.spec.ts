import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { runSceneCli } from "../../src/scene-cli.js";
import { rgbaPng } from "../brand/raster-test-helper.js";
import { compare, compareCloe, loadCloeReference, render } from "./cloe-visual-helpers.js";

async function traceCloe(page: Page, info: TestInfo, highDetail: boolean) {
  await loadCloeReference(page);
  const input = await render(page, "/reference.webp", 1024, 1536);
  await mkdir(info.outputDir, { recursive: true });
  await writeFile(info.outputPath("reference.png"), rgbaPng(1024, 1536, input));
  let messages = "";
  const io = { stdout: (value: string) => { messages += value; }, stderr: (value: string) => { messages += value; } };
  expect(await runSceneCli(["trace-png", "reference.png", "--output", "cloe.json", ...(highDetail ? ["--high-detail"] : [])], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli(["compile", "cloe.json", "--output", "cloe.svg", ...(highDetail ? [] : ["--compact-paths"])], info.outputDir, io), messages).toBe(0);
  const svg = await readFile(info.outputPath("cloe.svg"), "utf8");
  expect(svg).not.toMatch(/<(?:image|foreignObject|script)\b|\bhref\s*=/);
  expect(svg.match(/<path /g)?.length).toBeGreaterThan(1);
  expect(Buffer.byteLength(svg)).toBeLessThan(5_000_000);
  await page.route("http://cloe.test/cloe.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svg }));
  return svg;
}

test("Cloe mascot traces into a visually faithful editable SVG", async ({ page, browserName }, info) => {
  test.setTimeout(60_000);
  await traceCloe(page, info, false);
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
    const results = compareCloe(before, after, width, height);
    await info.attach(`pixel-errors-${width}.json`, { body: JSON.stringify(results), contentType: "application/json" });
    for (const region of ["full", "face", "tablet"] as const) {
      expect(results[region].mean, `${width}px ${region} mean RGB error`).toBeLessThan(meanLimits[region]);
      expect(results[region].severe, `${width}px ${region} large-error rate`).toBeLessThan(severeLimit);
    }
  }
});

test("Cloe high-detail SVG preserves sharp features when enlarged", async ({ page }, info) => {
  test.setTimeout(60_000);
  const svg = await traceCloe(page, info, true);
  expect(svg).toContain('viewBox="0 0 768 1152"');
  for (const width of [512, 768, 1024]) {
    const height = width * 1.5;
    const before = await render(page, "/reference.webp", width, height);
    const after = await render(page, "/cloe.svg", width, height);
    const results = compareCloe(before, after, width, height);
    await info.attach(`high-detail-errors-${width}.json`, { body: JSON.stringify(results), contentType: "application/json" });
    const meanLimits = width === 1024
      ? { full: 7.6, face: 12.5, tablet: 8.5 }
      : { full: 6, face: 8.6, tablet: 7 };
    for (const region of ["full", "face", "tablet"] as const) {
      expect(results[region].mean, `${width}px ${region} mean RGB error`).toBeLessThan(meanLimits[region]);
      expect(results[region].severe, `${width}px ${region} large-error rate`).toBeLessThan(0.08);
    }
  }
});
