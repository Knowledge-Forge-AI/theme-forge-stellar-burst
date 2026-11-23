import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { runSceneCli } from "../../src/scene-cli.js";
import { rgbaPng } from "../brand/raster-test-helper.js";
import { alphaMeanError, compare, compareCloe, loadCloeReference, loadOrihimeReference, orihimeRegions, render } from "./cloe-visual-helpers.js";

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

test("Cloe native-detail SVG preserves line work at raster delivery sizes", async ({ page }, info) => {
  test.setTimeout(90_000);
  const svg = await traceCloe(page, info, "--native-detail");
  expect(svg).toContain('viewBox="0 0 1024 1536"');

  const replacement = "M0 0H1023V1536H0Z";
  await writeFile(info.outputPath("edit.json"), JSON.stringify([{ id: "trace-base", d: replacement }]));
  let messages = "";
  const io = { stdout: (value: string) => { messages += value; }, stderr: (value: string) => { messages += value; } };
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
  expect(cutSvg === svg).toBe(false);
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

  for (const width of [384, 512, 768, 1024]) {
    const height = width * 1.5;
    const before = await render(page, "/reference.webp", width, height);
    const after = await render(page, "/cloe.svg", width, height);
    const results = compareCloe(before, after, width, height);
    for (const variant of ["cut", "tablet", "reopened-edit"]) {
      const edited = await render(page, `/${variant}.svg`, width, height);
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
