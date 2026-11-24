import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { runSceneCli } from "../../src/scene-cli.js";
import { rgbaPng } from "../brand/raster-test-helper.js";
import { alphaMeanError, cloeFaceContourBounds, compare, compareCloe, cloeHairSatchelBounds, cloeStylusBounds, cloeSupportingHandBounds, cloeTrouserShoeBounds, loadCloeReference, loadOrihimeReference, meanLineError, orihimeRegions, render } from "./cloe-visual-helpers.js";

async function traceCloe(page: Page, info: TestInfo, detail?: "--regular" | "--native-detail") {
  await loadCloeReference(page);
  const input = await render(page, "/reference.webp", 1024, 1536);
  await mkdir(info.outputDir, { recursive: true });
  await writeFile(info.outputPath("reference.png"), rgbaPng(1024, 1536, input));
  let messages = "";
  const io = { stdout: (value: string) => { messages += value; }, stderr: (value: string) => { messages += value; } };
  expect(await runSceneCli(["trace-png", "reference.png", "--output", "cloe.json", ...(detail ? [detail] : [])], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli(["compile", "cloe.json", "--output", "cloe.svg", ...(detail === "--regular" ? ["--compact-paths"] : [])], info.outputDir, io), messages).toBe(0);
  const svg = await readFile(info.outputPath("cloe.svg"), "utf8");
  expect(svg).not.toMatch(/<(?:image|foreignObject|script)\b|\bhref\s*=/);
  expect(svg.match(/<path /g)?.length).toBeGreaterThan(1);
  expect(Buffer.byteLength(svg)).toBeLessThan(16_000_000);
  await page.route("http://cloe.test/cloe.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svg }));
  return svg;
}

test("Cloe mascot traces into a visually faithful editable SVG", async ({ page, browserName }, info) => {
  test.setTimeout(60_000);
  await traceCloe(page, info, "--regular");
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
  const svg = await traceCloe(page, info);
  expect(svg).toContain('viewBox="0 0 768 1152"');
  for (const width of [512, 768, 1024]) {
    const height = width * 1.5;
    const before = await render(page, "/reference.webp", width, height);
    const after = await render(page, "/cloe.svg", width, height);
    const results = compareCloe(before, after, width, height);
    await info.attach(`high-detail-errors-${width}.json`, { body: JSON.stringify(results), contentType: "application/json" });
    const meanLimits = width === 1024
      ? { full: 6, face: 10.2, tablet: 8 }
      : width === 768 ? { full: 2.6, face: 3.25, tablet: 4 } : { full: 4.6, face: 6.7, tablet: 5.8 };
    for (const region of ["full", "face", "tablet"] as const) {
      expect(results[region].mean, `${width}px ${region} mean RGB error`).toBeLessThan(meanLimits[region]);
      expect(results[region].severe, `${width}px ${region} large-error rate`).toBeLessThan(0.08);
    }
  }
});

test("Cloe editable line refinement improves full-frame SVG delivery", async ({ page }, info) => {
  test.setTimeout(90_000);
  const baseline = await traceCloe(page, info, "--native-detail");
  const edit = await readFile(new URL("./fixtures/cloe-multiscale-edit.json", import.meta.url));
  await writeFile(info.outputPath("line-edit.json"), edit);
  let messages = "";
  const io = { stdout: (value: string) => { messages += value; }, stderr: (value: string) => { messages += value; } };
  expect(await runSceneCli([
    "revise", "cloe.json", "--edits", "line-edit.json", "--output", "line-refined.json",
  ], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli([
    "compile", "line-refined.json", "--illustration-source", "--output", "line-refined.svg",
  ], info.outputDir, io), messages).toBe(0);
  const refined = await readFile(info.outputPath("line-refined.svg"), "utf8");
  expect(refined).toContain('viewBox="0 0 1024 1536"');
  expect(Buffer.byteLength(refined)).toBeLessThanOrEqual(16_000_000);
  const start = refined.lastIndexOf('  <g id="line-repair">');
  expect(start).toBeGreaterThan(0);
  expect(refined.slice(0, start) + "</svg>\n" === baseline).toBe(true);
  await page.route("http://cloe.test/line-refined.svg", route =>
    route.fulfill({ contentType: "image/svg+xml", body: refined }));
  const faceEdit = await readFile(new URL("./fixtures/cloe-face-edit.json", import.meta.url));
  await writeFile(info.outputPath("face-edit.json"), faceEdit);
  expect(await runSceneCli([
    "revise", "line-refined.json", "--edits", "face-edit.json", "--output", "face-refined.json",
  ], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli([
    "compile", "face-refined.json", "--illustration-source", "--output", "face-refined.svg",
  ], info.outputDir, io), messages).toBe(0);
  const faceRefined = await readFile(info.outputPath("face-refined.svg"), "utf8");
  expect(Buffer.byteLength(faceRefined)).toBeLessThanOrEqual(16_000_000);
  expect(faceRefined).toContain('  <g id="face-contour-refinement">');
  await writeFile(info.outputPath("remove-face.json"), JSON.stringify({ removeGroup: "face-contour-refinement" }));
  expect(await runSceneCli([
    "revise", "face-refined.json", "--edits", "remove-face.json", "--output", "face-restored.json",
  ], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli([
    "compile", "face-restored.json", "--illustration-source", "--output", "face-restored.svg",
  ], info.outputDir, io), messages).toBe(0);
  expect((await readFile(info.outputPath("face-restored.svg"), "utf8")) === refined).toBe(true);
  await page.route("http://cloe.test/face-refined.svg", route =>
    route.fulfill({ contentType: "image/svg+xml", body: faceRefined }));
  const seamEdit = await readFile(new URL("./fixtures/cloe-seam-and-tablet-edit.json", import.meta.url));
  await writeFile(info.outputPath("seam-edit.json"), seamEdit);
  expect(await runSceneCli([
    "revise", "face-refined.json", "--edits", "seam-edit.json", "--output", "seam-refined.json",
  ], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli([
    "compile", "seam-refined.json", "--illustration-source", "--output", "seam-refined.svg",
  ], info.outputDir, io), messages).toBe(0);
  const seamRefined = await readFile(info.outputPath("seam-refined.svg"), "utf8");
  const seamStart = seamRefined.lastIndexOf('  <g id="seam-and-tablet-refinement">');
  expect(seamStart).toBeGreaterThan(0);
  expect(seamRefined.slice(0, seamStart) + "</svg>\n" === faceRefined).toBe(true);
  await page.route("http://cloe.test/seam-refined.svg", route =>
    route.fulfill({ contentType: "image/svg+xml", body: seamRefined }));
  const contourEdit = await readFile(new URL("./fixtures/cloe-hair-and-satchel-edit.json", import.meta.url));
  await writeFile(info.outputPath("hair-satchel-edit.json"), contourEdit);
  expect(await runSceneCli([
    "revise", "seam-refined.json", "--edits", "hair-satchel-edit.json", "--output", "hair-satchel.json",
  ], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli([
    "compile", "hair-satchel.json", "--illustration-source", "--output", "hair-satchel.svg",
  ], info.outputDir, io), messages).toBe(0);
  const contour = await readFile(info.outputPath("hair-satchel.svg"), "utf8");
  expect(Buffer.byteLength(contour)).toBeLessThanOrEqual(16_000_000);
  const contourStart = contour.lastIndexOf('  <g id="hair-and-satchel-refinement">');
  expect(contourStart).toBeGreaterThan(0);
  expect(contour.slice(0, contourStart) + "</svg>\n" === seamRefined).toBe(true);
  const lowerEdit = await readFile(new URL("./fixtures/cloe-trouser-and-shoe-edit.json", import.meta.url));
  await writeFile(info.outputPath("trouser-shoe-edit.json"), lowerEdit);
  expect(await runSceneCli([
    "revise", "hair-satchel.json", "--edits", "trouser-shoe-edit.json", "--output", "trouser-shoe.json",
  ], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli([
    "compile", "trouser-shoe.json", "--illustration-source", "--output", "trouser-shoe.svg",
  ], info.outputDir, io), messages).toBe(0);
  const lower = await readFile(info.outputPath("trouser-shoe.svg"), "utf8");
  expect(Buffer.byteLength(lower)).toBeLessThanOrEqual(16_000_000);
  expect(lower).toContain('viewBox="0 0 1024 1536"');
  const lowerStart = lower.lastIndexOf('  <g id="trouser-and-shoe-refinement">');
  expect(lowerStart).toBeGreaterThan(0);
  expect(lower.slice(0, lowerStart) + "</svg>\n" === contour).toBe(true);
  const lowerDigest = `sha256:${createHash("sha256").update(lower).digest("hex")}`;
  expect(await runSceneCli([
    "import-svg", "trouser-shoe.svg", "--svg-source", "--expect-svg-digest", lowerDigest,
    "--output", "trouser-shoe-reopened.json",
  ], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli([
    "compile", "trouser-shoe-reopened.json", "--illustration-source", "--output", "trouser-shoe-recompiled.svg",
  ], info.outputDir, io), messages).toBe(0);
  expect((await readFile(info.outputPath("trouser-shoe-recompiled.svg"), "utf8")) === lower).toBe(true);
  const stylusEdit = await readFile(new URL("./fixtures/cloe-stylus-contour-edit.json", import.meta.url));
  await writeFile(info.outputPath("stylus-edit.json"), stylusEdit);
  expect(await runSceneCli([
    "revise", "trouser-shoe-reopened.json", "--edits", "stylus-edit.json", "--output", "stylus.json",
  ], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli([
    "compile", "stylus.json", "--illustration-source", "--output", "stylus.svg",
  ], info.outputDir, io), messages).toBe(0);
  const stylus = await readFile(info.outputPath("stylus.svg"), "utf8");
  expect(Buffer.byteLength(stylus)).toBeLessThanOrEqual(16_000_000);
  const stylusStart = stylus.lastIndexOf('  <g id="stylus-contour-refinement">');
  expect(stylusStart).toBeGreaterThan(0);
  expect(stylus.slice(0, stylusStart) + "</svg>\n" === lower).toBe(true);
  await page.route("http://cloe.test/stylus.svg", route =>
    route.fulfill({ contentType: "image/svg+xml", body: stylus }));
  const handEdit = await readFile(new URL("./fixtures/cloe-supporting-hand-edit.json", import.meta.url));
  await writeFile(info.outputPath("hand-edit.json"), handEdit);
  expect(await runSceneCli([
    "revise", "stylus.json", "--edits", "hand-edit.json", "--output", "hand.json",
  ], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli([
    "compile", "hand.json", "--illustration-source", "--output", "hand.svg",
  ], info.outputDir, io), messages).toBe(0);
  const hand = await readFile(info.outputPath("hand.svg"), "utf8");
  expect(Buffer.byteLength(hand)).toBeLessThanOrEqual(16_000_000);
  const handStart = hand.lastIndexOf('  <g id="hand-line-color-refinement">');
  expect(handStart).toBeGreaterThan(0);
  expect(hand.slice(0, handStart) + "</svg>\n" === stylus).toBe(true);
  await page.route("http://cloe.test/hand.svg", route =>
    route.fulfill({ contentType: "image/svg+xml", body: hand }));
  await page.route("http://cloe.test/trouser-shoe.svg", route =>
    route.fulfill({ contentType: "image/svg+xml", body: lower }));
  await page.route("http://cloe.test/hair-satchel.svg", route =>
    route.fulfill({ contentType: "image/svg+xml", body: contour }));
  for (const width of [384, 1024]) {
    const height = width * 1.5;
    const original = await render(page, "/reference.webp", width, height);
    const before = await render(page, "/cloe.svg", width, height);
    const after = await render(page, "/line-refined.svg", width, height);
    for (const region of [[317, 15, 696, 145], [655, 307, 849, 522]] as const) {
      const scale = (edge: number) => Math.floor(edge * width / 1024);
      const bounds = [scale(region[0]), scale(region[1]), scale(region[2]), scale(region[3])] as const;
      const baselineError = meanLineError(original, before, width, bounds);
      const refinedError = meanLineError(original, after, width, bounds);
      if (width === 1024) expect(refinedError).toBeLessThan(baselineError);
      else expect(refinedError).toBeLessThanOrEqual(baselineError + 0.05);
    }
    const face = await render(page, "/face-refined.svg", width, height);
    const contours = cloeFaceContourBounds(width);
    expect(meanLineError(original, face, width, contours), `${width}px face contour RGB error`)
      .toBeLessThan(meanLineError(original, after, width, contours) - 0.01);
    const seams = await render(page, "/seam-refined.svg", width, height);
    for (const [region, [left, top, right, bottom]] of [
      ["cardigan knit", [390, 327, 552, 575]],
      ["tablet lines", [656, 335, 821, 517]],
    ] as const) {
      const scale = (edge: number) => Math.floor(edge * width / 1024);
      const bounds = [scale(left), scale(top), scale(right), scale(bottom)] as const;
      expect(meanLineError(original, seams, width, bounds), `${width}px ${region} edge error`)
        .toBeLessThan(meanLineError(original, face, width, bounds) - 0.002);
    }
    const final = await render(page, "/hair-satchel.svg", width, height);
    for (const [region, bounds] of Object.entries(cloeHairSatchelBounds(width))) {
      expect(meanLineError(original, final, width, bounds), `${width}px editable ${region} edge error`)
        .toBeLessThan(meanLineError(original, seams, width, bounds));
    }
    const lowerBody = await render(page, "/trouser-shoe.svg", width, height);
    for (const [region, bounds] of Object.entries(cloeTrouserShoeBounds(width))) {
      expect(meanLineError(original, lowerBody, width, bounds), `${width}px editable ${region} edge error`)
        .toBeLessThan(meanLineError(original, final, width, bounds));
    }
    const refinedStylus = await render(page, "/stylus.svg", width, height);
    const stylusBounds = cloeStylusBounds(width);
    expect(meanLineError(original, refinedStylus, width, stylusBounds), `${width}px stylus edge error`)
      .toBeLessThan(meanLineError(original, lowerBody, width, stylusBounds));
    const refinedHand = await render(page, "/hand.svg", width, height);
    const handBounds = cloeSupportingHandBounds(width);
    expect(meanLineError(original, refinedHand, width, handBounds), `${width}px supporting hand edge error`)
      .toBeLessThan(meanLineError(original, refinedStylus, width, handBounds));
  }
});

test("Cloe native-detail SVG preserves line work at raster delivery sizes", async ({ page }, info) => {
  test.setTimeout(90_000);
  const svg = await traceCloe(page, info, "--native-detail");
  expect(svg).toContain('viewBox="0 0 1024 1536"');

  const replacement = "M0 0H1023V1536H0Z";
  await writeFile(info.outputPath("edit.json"), JSON.stringify([{ id: "trace-base", d: replacement }]));
  let messages = "";
  const io = { stdout: (value: string) => { messages += value; }, stderr: (value: string) => { messages += value; } };
  const width = 1024, height = 1536;
  const original = await render(page, "/reference.webp", width, height);
  const busy = Buffer.from(original);
  // Add reproducible high-frequency detail so the native scene only fits
  // after lossless path compaction. The original fixture stays intact.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const offset = 4 * (y * width + x);
      for (let channel = 0; channel < 3; channel++) {
        const i = offset + channel;
        const center = original[i]!;
        const neighbors = original[i - 4]! + original[i + 4]! + original[i - 4 * width]! + original[i + 4 * width]!;
        busy[i] = Math.min(255, Math.max(0, center + Math.trunc((4 * center - neighbors) * 70 / 400)));
      }
    }
  }
  await writeFile(info.outputPath("busy.png"), rgbaPng(width, height, busy));
  expect(await runSceneCli([
    "trace-png", "busy.png", "--native-detail", "--output", "busy.json",
  ], info.outputDir, io), messages).toBe(0);
  const busyScene = await readFile(info.outputPath("busy.json"));
  expect(busyScene.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(JSON.parse(busyScene.toString()).artboard.viewBox).toEqual([0, 0, width, height]);
  expect(await runSceneCli([
    "compile", "busy.json", "--illustration-source", "--output", "busy.svg",
  ], info.outputDir, io), messages).toBe(0);
  expect((await readFile(info.outputPath("busy.svg"))).byteLength).toBeLessThanOrEqual(16_000_000);

  expect(await runSceneCli([
    "revise", "cloe.json", "--edits", "edit.json", "--output", "revised.json",
  ], info.outputDir, io), messages).toBe(0);
  const revised = await readFile(info.outputPath("revised.json"), "utf8");
  expect(Buffer.byteLength(revised)).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(JSON.parse(revised).elements[0]).toMatchObject({ id: "trace-base", d: replacement });
  expect(await runSceneCli(["compile", "revised.json", "--output", "revised.svg"], info.outputDir, io), messages).toBe(0);
  const revisedSvg = await readFile(info.outputPath("revised.svg"), "utf8");
  expect(revisedSvg).toBe(svg.replace('d="M 0 0 H 1024 V 1536 H 0 Z"', 'd="M 0 0 H 1023 V 1536 H 0 Z"'));
  const exclusion = await readFile(new URL("./fixtures/cloe-tablet-exclusion.json", import.meta.url));
  await writeFile(info.outputPath("exclusion.json"), exclusion);
  expect(await runSceneCli([
    "trace-png", "reference.png", "--native-detail", "--exclude-detail", "exclusion.json", "--output", "cut.json",
  ], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli(["compile", "cut.json", "--output", "cut.svg"], info.outputDir, io), messages).toBe(0);
  const cutSvg = await readFile(info.outputPath("cut.svg"), "utf8");
  const patchStart = cutSvg.indexOf('  <path id="trace-edit-underpaint-');
  expect(patchStart).toBeGreaterThan(0);
  // The retouch patch comes after all original paint, without modifying it.
  expect(cutSvg.slice(0, patchStart) + "</svg>\n" === svg).toBe(true);
  await page.route("http://cloe.test/cut.svg", route =>
    route.fulfill({ contentType: "image/svg+xml", body: cutSvg }));
  const overlay = await readFile(new URL("./fixtures/cloe-tablet-edit.json", import.meta.url));
  await writeFile(info.outputPath("tablet-edit.json"), overlay);
  expect(await runSceneCli([
    "revise", "cut.json", "--edits", "tablet-edit.json", "--output", "tablet.json",
  ], info.outputDir, io), messages).toBe(0);
  expect((await readFile(info.outputPath("tablet.json"))).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(await runSceneCli(["compile", "tablet.json", "--output", "tablet.svg"], info.outputDir, io), messages).toBe(0);
  const tabletSvg = await readFile(info.outputPath("tablet.svg"), "utf8");
  expect(Buffer.byteLength(tabletSvg)).toBeLessThanOrEqual(16_000_000);
  const groupStart = tabletSvg.lastIndexOf('  <g id="cloe-tablet-display">');
  expect(groupStart).toBeGreaterThan(0);
  expect(tabletSvg.slice(0, groupStart) + "</svg>\n" === cutSvg).toBe(true);
  await page.route("http://cloe.test/tablet.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: tabletSvg }));
  const reviewDigest = "sha256:" + createHash("sha256").update(tabletSvg).digest("hex");
  expect(await runSceneCli([
    "import-svg", "tablet.svg", "--svg-source", "--expect-svg-digest", reviewDigest, "--output", "reopened.json",
  ], info.outputDir, io), messages).toBe(0);
  expect((await readFile(info.outputPath("reopened.json"))).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(await runSceneCli(["compile", "reopened.json", "--output", "roundtrip.svg"], info.outputDir, io), messages).toBe(0);
  expect(await readFile(info.outputPath("roundtrip.svg"), "utf8") === tabletSvg).toBe(true);

  const graph = "M 710 419 L 735 401 L 760 414 L 779 368 M 735 401 L 721 372 M 735 401 L 769 392";
  const newGraph = graph + " M 721 372 L 779 368";
  await writeFile(info.outputPath("graph-edit.json"), JSON.stringify([{ id: "cloe-tablet-display-graph", d: newGraph }]));
  expect(await runSceneCli([
    "revise", "reopened.json", "--edits", "graph-edit.json", "--output", "reopened-edit.json",
  ], info.outputDir, io), messages).toBe(0);
  expect(await runSceneCli([
    "compile", "reopened-edit.json", "--output", "reopened-edit.svg",
  ], info.outputDir, io), messages).toBe(0);
  const reopenedEdit = await readFile(info.outputPath("reopened-edit.svg"), "utf8");
  expect(Buffer.byteLength(reopenedEdit)).toBeLessThanOrEqual(16_000_000);
  expect(reopenedEdit === tabletSvg.replace(`d="${graph}"`, `d="${newGraph}"`)).toBe(true);
  await page.route("http://cloe.test/reopened-edit.svg", route =>
    route.fulfill({ contentType: "image/svg+xml", body: reopenedEdit }));

  async function compareSizes(target: Page, widths: readonly number[]) {
    for (const width of widths) {
      const height = width * 1.5;
      const before = await render(target, "/reference.webp", width, height);
      const after = await render(target, "/cloe.svg", width, height);
      const results = compareCloe(before, after, width, height);
      for (const variant of ["cut", "tablet", "reopened-edit"]) {
        const edited = await render(target, `/${variant}.svg`, width, height);
        const scale = width / 1024;
        let changed = 0;
        let outside = 0;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * 4;
            if (after.readUInt32LE(i) === edited.readUInt32LE(i)) continue;
            changed += 1;
            if (x < 678 * scale || x >= 812 * scale || y < 336 * scale || y >= 452 * scale) outside += 1;
          }
        }
        expect(changed).toBeGreaterThan(5_000 * scale ** 2);
        expect(outside).toBe(0);
        await info.attach(`${variant}-edit-${width}.json`, { body: JSON.stringify({ changed, outside }), contentType: "application/json" });
      }
      if (width !== 512 && width !== 1024) continue;
      await info.attach(`native-detail-errors-${width}.json`, { body: JSON.stringify(results), contentType: "application/json" });
      const limits = width === 1024 ? { full: 1.89, face: 2.06, tablet: 3.1 } : { full: 3.5, face: 5, tablet: 4.5 };
      for (const region of ["full", "face", "tablet"] as const) {
        expect(results[region].mean, `${width}px ${region} mean RGB error`).toBeLessThan(limits[region]);
        expect(results[region].severe, `${width}px ${region} large-error rate`).toBeLessThan(0.025);
      }
    }
  }

  // The full-size SVG renders independently of the smaller comparisons.
  const fullSize = await page.context().newPage();
  try {
    await loadCloeReference(fullSize);
    const drawings = { cloe: svg, cut: cutSvg, tablet: tabletSvg, "reopened-edit": reopenedEdit };
    for (const [name, body] of Object.entries(drawings)) {
      await fullSize.route(`http://cloe.test/${name}.svg`, route =>
        route.fulfill({ contentType: "image/svg+xml", body }));
    }
    const results = await Promise.allSettled([compareSizes(page, [384, 512, 768]), compareSizes(fullSize, [1024])]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  } finally {
    await fullSize.close();
  }
});

test("a full-body transparent illustration preserves its artwork and opacity", async ({ page }, info) => {
  test.setTimeout(90_000);
  const hash = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
  const origin = "http://orihime.test";
  await loadOrihimeReference(page);

  const input = await render(page, "/reference.webp", 1024, 1536, null);
  await mkdir(info.outputDir, { recursive: true });
  await writeFile(info.outputPath("reference.png"), rgbaPng(1024, 1536, input));
  async function scene(args: string[]) {
    let messages = "";
    const io = { stdout: (value: string) => { messages += value; }, stderr: (value: string) => { messages += value; } };
    expect(await runSceneCli([...args, "--json"], info.outputDir, io), messages).toBe(0);
  }
  await scene(["trace-png", "reference.png", "--native-detail", "--preserve-alpha", "--output", "orihime.json"]);
  await scene(["compile", "orihime.json", "--output", "orihime.svg"]);
  const svg = await readFile(info.outputPath("orihime.svg"));
  expect(svg.byteLength).toBeLessThanOrEqual(16_000_000);
  const artwork = svg.toString("utf8");
  expect(artwork).toContain('viewBox="0 0 1024 1536"');
  expect(artwork).not.toMatch(/<(?:image|foreignObject|script)\b|\bhref\s*=/);
  await scene(["import-svg", "orihime.svg", "--svg-source", "--expect-svg-digest", hash(svg), "--output", "reopened.json"]);
  await scene(["compile", "reopened.json", "--output", "roundtrip.svg"]);
  expect((await readFile(info.outputPath("roundtrip.svg"))).equals(svg)).toBe(true);
  await page.route(origin + "/orihime.svg", route => route.fulfill({
    contentType: "image/svg+xml", body: svg,
  }));

  const { full, face, prop } = orihimeRegions;
  for (const width of [384, 1024]) {
    const height = width * 1.5;
    const reference = await render(page, "/reference.webp", width, height, null);
    const candidate = await render(page, "/orihime.svg", width, height, null);
    expect(reference[3]).toBe(0);
    expect(candidate[3]).toBe(0);
    const alpha = alphaMeanError(reference, candidate);
    expect(alpha, `${width}px alpha mean error`).toBeLessThan(width === 1024 ? 1.1 : 5);
    const rgb = [];
    for (const background of ["#f8f3fa", "#202031"]) {
      const before = await render(page, "/reference.webp", width, height, background);
      const after = await render(page, "/orihime.svg", width, height, background);
      const values = [full, face, prop].map(region => compare(before, after, width, height, region).mean);
      // macOS WebKit's subpixel sampling at 384 px raises the prop mean to 11.14.
      const limits = width === 1024 ? [2, 3, 3] : [5, 9, 12];
      for (const [index, value] of values.entries()) {
        expect(value, `${width}px ${background} region ${index} RGB mean error`).toBeLessThan(limits[index]!);
      }
      rgb.push({ background, full: values[0], face: values[1], prop: values[2] });
    }
    await info.attach(`orihime-${width}-errors.json`, {
      body: JSON.stringify({ outsideAlpha: candidate[3], alpha, rgb }), contentType: "application/json",
    });
  }
});

test("an authored illustration preserves its layers and isolates a tablet edit", async ({ page }, info) => {
  const source = await readFile(new URL("./fixtures/layered-illustration.svg", import.meta.url));
  await mkdir(info.outputDir, { recursive: true });
  await writeFile(info.outputPath("source.svg"), source);

  async function scene(args: string[]) {
    let messages = "";
    const io = { stdout: (value: string) => { messages += value; }, stderr: (value: string) => { messages += value; } };
    expect(await runSceneCli([...args, "--json"], info.outputDir, io), messages).toBe(0);
    return JSON.parse(messages).data;
  }

  const imported = await scene(["import-svg", "source.svg", "--output", "source.json"]);
  expect(imported.classification).toBe("SUPPORTED_IMPORT");
  const originalScene = JSON.parse(await readFile(info.outputPath("source.json"), "utf8"));
  expect(originalScene.elements.map(({ id }: { id: string }) => id))
    .toEqual(["hair-back", "garment", "face", "hair-front", "tablet"]);
  expect(originalScene.accessibility).toMatchObject({
    mode: "labelled", title: "Cel-shaded observatory apprentice",
    desc: "A silver-haired apprentice carries a violet star chart.",
  });
  await scene(["compile", "source.json", "--output", "imported.svg"]);
  const edits = [{ id: "tablet-bezel", d: "M146 211H201L197 257H141Z" }];
  await writeFile(info.outputPath("edits.json"), JSON.stringify(edits));
  await scene(["revise", "source.json", "--edits", "edits.json", "--output", "revised.json"]);
  const revisedScene = JSON.parse(await readFile(info.outputPath("revised.json"), "utf8"));
  const tablet = originalScene.elements.find(({ id }: { id: string }) => id === "tablet");
  tablet.children.find(({ id }: { id: string }) => id === "tablet-bezel").d = "M 146 211 H 201 L 197 257 H 141 Z";
  expect(revisedScene).toEqual(originalScene);
  await scene(["compile", "revised.json", "--output", "revised.svg"]);

  await page.route("http://artwork.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Illustration preview</title>" }));
  for (const name of ["source.svg", "imported.svg", "revised.svg"]) {
    const bytes = await readFile(info.outputPath(name));
    expect(bytes.length).toBeLessThanOrEqual(16_000_000);
    await page.route("http://artwork.test/" + name, (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: bytes }));
  }
  await page.goto("http://artwork.test/");

  for (const scale of [1, 2]) {
    const width = 240 * scale, height = 300 * scale;
    const reference = await render(page, "/source.svg", width, height);
    const imported = await render(page, "/imported.svg", width, height);
    const revised = await render(page, "/revised.svg", width, height);
    expect(imported.equals(reference), `Import changed pixels at scale ${scale}.`).toBe(true);
    let editedPixels = 0;
    let pixelsOutsideTablet = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (imported[i] === revised[i] && imported[i + 1] === revised[i + 1] &&
            imported[i + 2] === revised[i + 2] && imported[i + 3] === revised[i + 3]) continue;
        editedPixels += 1;
        if (x < 138 * scale || x >= 204 * scale || y < 208 * scale || y >= 260 * scale) pixelsOutsideTablet += 1;
      }
    }
    expect(editedPixels).toBeGreaterThan(100 * scale ** 2);
    expect(pixelsOutsideTablet).toBe(0);
  }
});
