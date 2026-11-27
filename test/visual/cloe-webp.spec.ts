import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { runSceneCli } from "../../src/scene-cli.js";
import { runIllustrationCli } from "../../src/illustration-cli.js";
import { createRasterDerivativeRecipe, probeMagickDerivativeCapability } from "../../src/illustration/derivative.js";
import { rgbaPng } from "../brand/raster-test-helper.js";
import { alphaMeanError, cloeChalkboardBounds, cloeFaceContourBounds, cloeHairSatchelBounds, cloeStylusBounds, cloeSupportingHandBounds, cloeTrouserShoeBounds, compare, compareCloe, meanLineError, loadCloeReference, loadOrihimeReference, orihimeRegions, render } from "./cloe-visual-helpers.js";

test("transparent editable SVG preserves alpha in Standard and Sharp WebP", async ({ page }, info) => {
  const width = 64, height = 96;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 12; y < 84; y += 1) {
    for (let x = 8; x < 56; x += 1) {
      const color = x < 31 ? [48, 96, 224, 128] : [224, 96, 48, 255];
      pixels.set(color, (y * width + x) * 4);
    }
  }
  await mkdir(info.outputDir, { recursive: true });
  const directory = await realpath(info.outputDir);
  await writeFile(info.outputPath("reference.png"), rgbaPng(width, height, pixels));
  async function scene(args: string[]) {
    let stdout = "", stderr = "";
    const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
    expect(await runSceneCli([...args, "--json"], directory, io), stdout + stderr).toBe(0);
    return JSON.parse(stdout).data;
  }
  await scene(["trace-png", "reference.png", "--native-detail", "--preserve-alpha", "--output", "source.json"]);
  const { receipt } = await scene(["compile", "source.json", "--illustration-source", "--output", "source.svg"]);
  const svg = await readFile(info.outputPath("source.svg"));
  const svgDigest = receipt.svgDigest;
  expect(svg.toString()).toContain('viewBox="0 0 64 96"');
  expect(svg.toString()).toContain("fill-opacity=");
  await scene(["import-svg", "source.svg", "--svg-source", "--expect-svg-digest", svgDigest, "--output", "reopened.json"]);
  await scene(["compile", "reopened.json", "--illustration-source", "--output", "reopened.svg"]);
  expect((await readFile(info.outputPath("reopened.svg"))).equals(svg)).toBe(true);

  const raster = await scene(["rasterize", "source.svg", "--svg-source", "--expect-svg-digest", svgDigest, "--output", "master.png"]);
  await page.route("http://alpha.test/", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Transparent illustration fixture</title>" }));
  await page.route("http://alpha.test/master.png", async route =>
    route.fulfill({ contentType: "image/png", body: await readFile(info.outputPath("master.png")) }));
  await page.goto("http://alpha.test/");
  const master = await render(page, "/master.png", width, height, null);
  expect([0, 16, 48, 63].map(x => master[(48 * width + x) * 4 + 3])).toEqual([0, 128, 255, 0]);
  const alpha = (rgba: Buffer) => rgba.filter((_, offset) => offset % 4 === 3);
  for (const [name, options] of [["standard", []], ["sharp", ["--quality", "93", "--sharp-chroma"]]] as const) {
    const output = `${name}.webp`;
    const proof = await scene(["export-webp", "source.svg", "--expect-svg-digest", svgDigest, "--output", output, ...options]);
    const webp = await readFile(info.outputPath(output));
    expect(proof).toMatchObject({
      svgDigest, pngDigest: raster.pngDigest,
      receipt: { width, height, outputSha256: `sha256:${createHash("sha256").update(webp).digest("hex")}` },
    });
    await page.route(`http://alpha.test/${output}`, route =>
      route.fulfill({ contentType: "image/webp", body: webp }));
    const decoded = await render(page, `/${output}`, width, height, null);
    expect(Buffer.compare(alpha(decoded), alpha(master)), `${name} alpha plane`).toBe(0);
  }
  const mobile = await scene([
    "export-webp", "source.svg", "--expect-svg-digest", svgDigest,
    "--output-width", "32", "--quality", "93", "--sharp-chroma", "--output", "mobile.webp",
  ]);
  expect(mobile).toMatchObject({ pngDigest: raster.pngDigest, receipt: { width: 32, height: 48 } });
  await page.route("http://alpha.test/mobile.webp", async route =>
    route.fulfill({ contentType: "image/webp", body: await readFile(info.outputPath("mobile.webp")) }));
  const area = await scene([
    "export-webp", "source.svg", "--expect-svg-digest", svgDigest,
    "--output-width", "40", "--resample", "area", "--output", "area.webp",
  ]);
  const areaWebp = await readFile(info.outputPath("area.webp"));
  expect(area).toMatchObject({
    svgDigest, pngDigest: raster.pngDigest,
    recipe: { schemaVersion: 3, output: { width: 40, height: 60, resample: "area-srgb-alpha-weighted-v1" } },
    receipt: { outputSha256: `sha256:${createHash("sha256").update(areaWebp).digest("hex")}` },
  });
  await page.route("http://alpha.test/area.webp", route =>
    route.fulfill({ contentType: "image/webp", body: areaWebp }));
  // Each output sample spans eight fifths of a source pixel. Use integer
  // fifths to intersect that footprint with the two known rectangle bands.
  const overlap = (pixel: number, start: number, end: number) =>
    Math.max(0, Math.min((pixel + 1) * 8, end * 5) - Math.max(pixel * 8, start * 5));
  const expectedAreaAlpha = Buffer.from(Array.from({ length: 40 * 60 }, (_, offset) => {
    const x = offset % 40, y = Math.floor(offset / 40);
    const opacity = overlap(x, 8, 31) * 128 + overlap(x, 31, 56) * 255;
    return Math.round(opacity * overlap(y, 12, 84) / 64);
  }));
  const areaPixels = await render(page, "/area.webp", 40, 60, null);
  expect(alpha(areaPixels)).toEqual(expectedAreaAlpha);

  const rgb6 = await scene([
    "export-webp", "source.svg", "--expect-svg-digest", svgDigest,
    "--output-width", "40", "--resample", "area", "--rgb6", "--output", "area-rgb6.webp",
  ]);
  const rgb6Webp = await readFile(info.outputPath("area-rgb6.webp"));
  expect(rgb6).toMatchObject({
    svgDigest, pngDigest: raster.pngDigest,
    recipe: { schemaVersion: 4, output: { width: 40, height: 60, encoding: "rgb6-vp8l-v1" } },
    receipt: { alpha: "has-alpha", outputSha256: `sha256:${createHash("sha256").update(rgb6Webp).digest("hex")}` },
  });
  expect(rgb6Webp.toString("ascii", 12, 16)).toBe("VP8L");
  await page.route("http://alpha.test/area-rgb6.webp", route =>
    route.fulfill({ contentType: "image/webp", body: rgb6Webp }));
  const rgb6Pixels = await render(page, "/area-rgb6.webp", 40, 60, null);
  expect(alpha(rgb6Pixels)).toEqual(expectedAreaAlpha);
  const flatBandOffset = (24 * 40 + 30) * 4;
  expect(Array.from(rgb6Pixels.subarray(flatBandOffset, flatBandOffset + 4))).toEqual([223, 97, 49, 255]);

  const lossless = await scene([
    "export-webp", "source.svg", "--expect-svg-digest", svgDigest,
    "--output-width", "38", "--resample", "area", "--quality", "100", "--output", "area-lossless.webp",
  ]);
  const losslessWebp = await readFile(info.outputPath("area-lossless.webp"));
  expect(lossless).toMatchObject({
    svgDigest, pngDigest: raster.pngDigest,
    recipe: { output: { width: 38, height: 57, resample: "area-srgb-alpha-weighted-v1" } },
  });
  await page.route("http://alpha.test/area-lossless.webp", route =>
    route.fulfill({ contentType: "image/webp", body: losslessWebp }));
  const areaLossless = await render(page, "/area-lossless.webp", 38, 57, null);
  // Column 18 spans both bands. Their distinct opacities give RGB
  // [179, 96, 93] with weighting, versus [153, 96, 119] without it.
  for (let y = 7; y < 50; y += 1) {
    const offset = (y * 38 + 18) * 4;
    expect(areaLossless[offset + 3], `edge alpha at row ${y}`).toBe(y === 7 || y === 49 ? 178 : 203);
    for (const [channel, expected] of [179, 96, 93].entries()) {
      // Browser canvas premultiplication can round the decoded color by one.
      expect(Math.abs(areaLossless.readUInt8(offset + channel) - expected), `edge channel ${channel} at row ${y}`)
        .toBeLessThanOrEqual(1);
    }
  }
  const mobilePixels = await render(page, "/mobile.webp", 32, 48, null);
  // Sample the flat bands and the far margin outside the Lanczos edge.
  expect(([[0, 0], [8, 24], [24, 24], [31, 47]] as const).map(([x, y]) =>
    mobilePixels[(y * 32 + x) * 4 + 3])).toEqual([0, 128, 255, 0]);
});

test("Cloe line refinement survives SVG reopen and repeatable WebP delivery", async ({ page }, info) => {
  test.setTimeout(120_000);
  const reference = await loadCloeReference(page);
  await mkdir(info.outputDir, { recursive: true });
  const directory = await realpath(info.outputDir);
  const fixture = await readFile(new URL("./fixtures/cloe-multiscale-edit.json", import.meta.url));
  await writeFile(info.outputPath("reference.webp"), reference);
  await writeFile(info.outputPath("line-edit.json"), fixture);
  const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  async function scene(args: string[]) {
    let stdout = "", stderr = "";
    const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
    expect(await runSceneCli([...args, "--json"], directory, io), stdout + stderr).toBe(0);
    return JSON.parse(stdout).data;
  }
  await scene(["trace-webp", "reference.webp", "--native-detail", "--output", "base.json"]);
  await scene(["compile", "base.json", "--illustration-source", "--output", "base.svg"]);
  const baseline = await readFile(info.outputPath("base.svg"));
  expect(sha256(baseline)).toBe("sha256:1de5a0f410c2cc6b8fc62bf3ba8e49a3439dd12f70c058ecc155bf4b3e437972");
  await scene(["revise", "base.json", "--edits", "line-edit.json", "--output", "refined.json"]);
  await scene(["compile", "refined.json", "--illustration-source", "--output", "refined.svg"]);
  const refined = await readFile(info.outputPath("refined.svg"));
  expect(refined.byteLength).toBeLessThanOrEqual(16_000_000);
  expect(refined.toString()).toContain('viewBox="0 0 1024 1536"');
  const end = refined.lastIndexOf('  <g id="line-repair">');
  expect(end).toBeGreaterThan(0);
  expect(Buffer.concat([refined.subarray(0, end), Buffer.from("</svg>\n")]).equals(baseline)).toBe(true);

  const digest = sha256(refined);
  await scene(["import-svg", "refined.svg", "--svg-source", "--expect-svg-digest", digest, "--output", "reopened.json"]);
  expect((await readFile(info.outputPath("reopened.json"))).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
  await scene(["compile", "reopened.json", "--illustration-source", "--output", "recompiled.svg"]);
  expect((await readFile(info.outputPath("recompiled.svg"))).equals(refined)).toBe(true);

  await page.route("http://cloe.test/line-base.svg", route =>
    route.fulfill({ contentType: "image/svg+xml", body: baseline }));
  await page.route("http://cloe.test/line-refined.svg", route =>
    route.fulfill({ contentType: "image/svg+xml", body: refined }));
  const originalPixels = await render(page, "/reference.webp", 1024, 1536);
  const baselinePixels = await render(page, "/line-base.svg", 1024, 1536);
  const refinedPixels = await render(page, "/line-refined.svg", 1024, 1536);
  for (const region of [[317, 15, 696, 145], [655, 307, 849, 522]] as const) {
    expect(meanLineError(originalPixels, refinedPixels, 1024, region))
      .toBeLessThan(meanLineError(originalPixels, baselinePixels, 1024, region));
  }

  const exportArgs = ["export-webp", "refined.svg", "--expect-svg-digest", digest, "--output-width", "512"];
  const first = await scene([...exportArgs, "--output", "refined.webp"]);
  const second = await scene([...exportArgs, "--output", "refined-repeat.webp"]);
  const webp = await readFile(info.outputPath("refined.webp"));
  expect(first).toMatchObject({
    svgDigest: digest, rasterWidth: 1024, rasterHeight: 1536,
    receipt: { width: 512, height: 768, outputSha256: sha256(webp) },
  });
  expect(second.receipt).toEqual(first.receipt);
  expect((await readFile(info.outputPath("refined-repeat.webp"))).equals(webp)).toBe(true);
  expect((await readFile(info.outputPath("refined.svg"))).equals(refined)).toBe(true);

  await page.route("http://cloe.test/line-refined.webp", route =>
    route.fulfill({ contentType: "image/webp", body: webp }));
  const responsiveReference = await render(page, "/reference.webp", 512, 768);
  const responsivePixels = await render(page, "/line-refined.webp", 512, 768);
  const { full } = compareCloe(responsiveReference, responsivePixels, 512, 768);
  expect(full.mean, "512-pixel full-frame RGB error").toBeLessThan(3.5);
  expect(full.severe, "512-pixel fraction of severe RGB errors").toBeLessThan(0.0005);

  const sharp = await scene([...exportArgs, "--quality", "93", "--sharp-chroma", "--output", "refined-sharp.webp"]);
  const sharpWebp = await readFile(info.outputPath("refined-sharp.webp"));
  expect(sharp).toMatchObject({
    svgDigest: digest,
    pngDigest: first.pngDigest,
    recipe: { schemaVersion: 2, output: { width: 512, height: 768, quality: 93, chroma: "sharp-yuv" } },
    receipt: { outputSha256: sha256(sharpWebp) },
  });
  expect(sharpWebp.byteLength).toBeLessThan(webp.byteLength * 1.02);
  await page.route("http://cloe.test/line-refined-sharp.webp", route =>
    route.fulfill({ contentType: "image/webp", body: sharpWebp }));
  const sharpPixels = await render(page, "/line-refined-sharp.webp", 512, 768);
  expect(compareCloe(responsiveReference, sharpPixels, 512, 768).full.mean).toBeLessThan(full.mean);
  for (const [label, region, limit] of [
    ["hair", [158, 7, 348, 72], 5.5],
    ["face", [168, 34, 327, 172], 8],
    ["tablet", [327, 153, 424, 261], 8],
  ] as const) {
    const standardError = meanLineError(responsiveReference, responsivePixels, 512, region);
    expect(standardError, `${label} edge RGB error`).toBeLessThan(limit);
    expect(meanLineError(responsiveReference, sharpPixels, 512, region), `${label} Sharp edge RGB error`)
      .toBeLessThan(standardError);
  }

  const faceEdit = await readFile(new URL("./fixtures/cloe-face-edit.json", import.meta.url));
  await writeFile(info.outputPath("face-edit.json"), faceEdit);
  await scene(["revise", "reopened.json", "--edits", "face-edit.json", "--output", "face.json"]);
  await scene(["compile", "face.json", "--illustration-source", "--compact-paths", "--output", "face.svg"]);
  const faceSvg = await readFile(info.outputPath("face.svg"));
  const faceDigest = sha256(faceSvg);
  const faceArgs = [
    "export-webp", "face.svg", "--expect-svg-digest", faceDigest, "--output-width", "512",
    "--quality", "94", "--sharp-chroma",
  ];
  const face = await scene([...faceArgs, "--output", "face.webp"]);
  const faceRepeat = await scene([...faceArgs, "--output", "face-repeat.webp"]);
  const faceWebp = await readFile(info.outputPath("face.webp"));
  expect(face).toMatchObject({
    svgDigest: faceDigest, rasterWidth: 1024, rasterHeight: 1536,
    recipe: { schemaVersion: 2, sourceSha256: face.pngDigest, output: { width: 512, height: 768, quality: 94, chroma: "sharp-yuv" } },
    receipt: { outputSha256: sha256(faceWebp), width: 512, height: 768 },
  });
  expect(face.pngDigest).not.toBe(sharp.pngDigest);
  expect(faceRepeat.receipt).toEqual(face.receipt);
  expect((await readFile(info.outputPath("face-repeat.webp"))).equals(faceWebp)).toBe(true);
  expect(faceWebp.byteLength).toBeLessThan(sharpWebp.byteLength * 1.07);
  await page.route("http://cloe.test/face-refined.webp", route =>
    route.fulfill({ contentType: "image/webp", body: faceWebp }));
  const faceFrames = new Map<number, { reference: Buffer; face: Buffer }>();
  for (const width of [384, 512]) {
    const height = width * 1.5;
    const src = width === 512 ? responsiveReference : await render(page, "/reference.webp", width, height);
    const before = width === 512 ? sharpPixels : await render(page, "/line-refined-sharp.webp", width, height);
    const after = await render(page, "/face-refined.webp", width, height);
    faceFrames.set(width, { reference: src, face: after });
    const bounds = cloeFaceContourBounds(width);
    expect(meanLineError(src, after, width, bounds), `${width}px Sharp face contour RGB error`)
      .toBeLessThan(meanLineError(src, before, width, bounds));
  }
  const seamEdit = await readFile(new URL("./fixtures/cloe-seam-and-tablet-edit.json", import.meta.url));
  await writeFile(info.outputPath("seam-edit.json"), seamEdit);
  await scene(["revise", "face.json", "--edits", "seam-edit.json", "--output", "seams.json"]);
  await scene(["compile", "seams.json", "--illustration-source", "--compact-paths", "--output", "seams.svg"]);
  const seamDigest = sha256(await readFile(info.outputPath("seams.svg")));
  const fineArgs = [
    "export-webp", "seams.svg", "--expect-svg-digest", seamDigest,
    "--output-width", "512", "--quality", "96", "--sharp-chroma",
  ];
  const fine = await scene([...fineArgs, "--output", "seams-fine.webp"]);
  const fineRepeat = await scene([...fineArgs, "--output", "seams-fine-repeat.webp"]);
  const fineWebp = await readFile(info.outputPath("seams-fine.webp"));
  expect(fine).toMatchObject({
    svgDigest: seamDigest, rasterWidth: 1024, rasterHeight: 1536,
    recipe: { schemaVersion: 2, sourceSha256: fine.pngDigest, output: { width: 512, height: 768, quality: 96, chroma: "sharp-yuv" } },
    receipt: { outputSha256: sha256(fineWebp), width: 512, height: 768 },
  });
  expect(fineRepeat.receipt).toEqual(fine.receipt);
  expect((await readFile(info.outputPath("seams-fine-repeat.webp"))).equals(fineWebp)).toBe(true);
  expect(fineWebp.byteLength).toBeLessThan(faceWebp.byteLength * 1.13);
  await page.route("http://cloe.test/seams-fine.webp", route =>
    route.fulfill({ contentType: "image/webp", body: fineWebp }));
  for (const width of [336, 384, 512]) {
    const height = width * 1.5;
    const frame = faceFrames.get(width);
    const src = frame?.reference ?? await render(page, "/reference.webp", width, height);
    const before = frame?.face ?? await render(page, "/face-refined.webp", width, height);
    const after = await render(page, "/seams-fine.webp", width, height);
    const scale = (edge: number) => Math.floor(edge * width / 1024);
    for (const [region, [left, top, right, bottom]] of [
      ["cardigan knit", [390, 327, 552, 575]],
      ["tablet lines", [656, 335, 821, 517]],
    ] as const) {
      const bounds = [scale(left), scale(top), scale(right), scale(bottom)] as const;
      expect(meanLineError(src, after, width, bounds), `${width}px Fine Sharp ${region} edge error`)
        .toBeLessThan(meanLineError(src, before, width, bounds));
    }
  }
});

test("Orihime SVG exports a repeatable WebP with the raster master's exact alpha", async ({ page }, info) => {
  test.setTimeout(120_000);
  const capability = await probeMagickDerivativeCapability();
  if (!capability.available) throw new Error("This suite requires the TFSB WebP processor (ImageMagick with WebP support).");
  await loadOrihimeReference(page);
  await mkdir(info.outputDir, { recursive: true });
  const directory = await realpath(info.outputDir);
  const width = 1024, height = 1536;
  const reference = await render(page, "/reference.webp", width, height, null);
  const referenceWebp = await readFile(new URL("../../website/orihime.webp", import.meta.url));
  await writeFile(info.outputPath("reference.webp"), referenceWebp);
  const sha256 = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
  async function scene(args: string[], exitCode = 0) {
    let stdout = "", stderr = "";
    const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
    expect(await runSceneCli([...args, "--json"], directory, io), stdout + stderr).toBe(exitCode);
    return JSON.parse(stdout);
  }
  const refused = await scene(["trace-webp", "reference.webp", "--native-detail", "--output", "no-alpha.json"], 1);
  expect(refused.diagnostics[0].code).toBe("SCENE_RASTER_TRACE_REJECTED");
  await expect(readFile(info.outputPath("no-alpha.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const traceArgs = ["trace-webp", "reference.webp", "--native-detail", "--preserve-alpha"];
  const { data: traced } = await scene([...traceArgs, "--output", "orihime.json"]);
  const sourceScene = await readFile(info.outputPath("orihime.json"));
  expect(traced).toMatchObject({
    action: "trace-webp",
    sourceSha256: sha256(referenceWebp).slice("sha256:".length),
    outputSha256: sha256(sourceScene).slice("sha256:".length),
    decodedPngSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    decodeRecipeDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
  });
  const { data: repeatedTrace } = await scene([...traceArgs, "--output", "trace-repeat.json"]);
  expect(repeatedTrace).toEqual({ ...traced, output: "trace-repeat.json" });
  expect((await readFile(info.outputPath("trace-repeat.json"))).equals(sourceScene)).toBe(true);
  await scene(["compile", "orihime.json", "--illustration-source", "--output", "orihime.svg"]);
  const svg = await readFile(info.outputPath("orihime.svg"));
  expect(svg.byteLength).toBeLessThanOrEqual(16_000_000);
  expect(svg.toString("utf8")).toContain('viewBox="0 0 1024 1536"');
  expect(svg.includes('id="trace-alpha-fine-underpaint-'), "native trace retains fine underpaint").toBe(true);
  const binding = ["--expect-svg-digest", sha256(svg)];
  await scene(["import-svg", "orihime.svg", "--svg-source", ...binding, "--output", "reopened.json"]);
  await scene(["compile", "reopened.json", "--illustration-source", "--output", "recompiled.svg"]);
  expect((await readFile(info.outputPath("recompiled.svg"))).equals(svg)).toBe(true);
  const { data: raster } = await scene(["rasterize", "orihime.svg", "--svg-source", ...binding, "--output", "render.png"]);
  const png = await readFile(info.outputPath("render.png"));
  expect(raster).toMatchObject({ svgDigest: sha256(svg), pngDigest: sha256(png), width, height });

  const { data: first } = await scene(["export-webp", "orihime.svg", ...binding, "--output", "orihime.webp"]);
  const { data: second } = await scene(["export-webp", "orihime.svg", ...binding, "--output", "repeat.webp"]);
  const webp = await readFile(info.outputPath("orihime.webp"));
  expect((await readFile(info.outputPath("repeat.webp"))).equals(webp)).toBe(true);
  expect(second.receipt).toEqual(first.receipt);
  expect(first).toMatchObject({
    svgDigest: raster.svgDigest,
    pngDigest: raster.pngDigest,
    rendererBuildDigest: raster.rendererBuildDigest,
    recipe: { sourceSha256: raster.pngDigest, output: { width, height, alpha: "preserve", quality: 94 } },
    receipt: { sourceSha256: raster.pngDigest, outputSha256: sha256(webp), width, height, mime: "image/webp", alpha: "has-alpha" },
  });
  expect(first.receipt.recipeDigest).toBe(first.recipe.recipeDigest);
  expect(webp.length).toBeLessThan(400_000);
  await scene(["compile", "orihime.json", "--compact-paths", "--illustration-source", "--output", "orihime-compact.svg"]);
  const compact = await readFile(info.outputPath("orihime-compact.svg"));
  expect(compact.byteLength).toBeLessThan(svg.byteLength);
  const { data: compactExport } = await scene([
    "export-webp", "orihime-compact.svg", "--expect-svg-digest", sha256(compact),
    "--output", "orihime-compact.webp",
  ]);
  expect(compactExport.svgDigest).toBe(sha256(compact));
  expect(compactExport.pngDigest).toBe(raster.pngDigest);
  expect(compactExport.receipt).toEqual(first.receipt);
  expect((await readFile(info.outputPath("orihime-compact.webp"))).equals(webp)).toBe(true);
  await page.route("http://orihime.test/render.png", route => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("http://orihime.test/orihime.webp", route => route.fulfill({ contentType: "image/webp", body: webp }));
  const decoded = await render(page, "/orihime.webp", width, height, null);
  expect(decoded[3]).toBe(0);
  expect(alphaMeanError(await render(page, "/render.png", width, height, null), decoded)).toBe(0);
  expect(alphaMeanError(reference, decoded)).toBeLessThan(1.1);

  const metrics = [];
  for (const displayWidth of [384, 1024]) {
    const displayHeight = displayWidth * 1.5;
    for (const background of ["#f8f3fa", "#202031"]) {
      const before = await render(page, "/reference.webp", displayWidth, displayHeight, background);
      const after = await render(page, "/orihime.webp", displayWidth, displayHeight, background);
      const master = await render(page, "/render.png", displayWidth, displayHeight, background);
      for (const [name, region] of Object.entries(orihimeRegions)) {
        const approximation = compare(before, after, displayWidth, displayHeight, region).mean;
        const encoding = compare(master, after, displayWidth, displayHeight, region).mean;
        expect(approximation, `${displayWidth}px ${background} ${name} reference error`).toBeLessThan(name === "full" ? 2.5 : 5);
        expect(encoding, `${displayWidth}px ${background} ${name} encoding error`).toBeLessThan(3);
        metrics.push({ displayWidth, background, region: name, approximation, encoding });
      }
    }
  }
  await info.attach("orihime-webp-evidence.json", {
    body: JSON.stringify({
      sourceWebpSha256: sha256(referenceWebp), decodedPngSha256: traced.decodedPngSha256,
      decodeRecipeDigest: traced.decodeRecipeDigest, sceneSha256: sha256(sourceScene), svgSha256: sha256(svg),
      svgBytes: svg.byteLength, webpBytes: webp.length, receipt: first.receipt, metrics,
    }),
    contentType: "application/json",
  });
});

async function runCloeScene(directory: string, args: string[], exitCode = 0) {
  let stdout = "", stderr = "";
  const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
  expect(await runSceneCli([...args, "--json"], directory, io), stdout + stderr).toBe(exitCode);
  return JSON.parse(stdout);
}

test("Cloe layered contour refinements preserve Fine Sharp WebP detail", async ({ page }, info) => {
  test.setTimeout(120_000);
  const capability = await probeMagickDerivativeCapability();
  if (!capability.available) throw new Error("This suite requires the TFSB WebP processor (ImageMagick with WebP support).");
  const reference = await loadCloeReference(page);
  await mkdir(info.outputDir, { recursive: true });
  const directory = await realpath(info.outputDir);
  await writeFile(info.outputPath("reference.webp"), reference);
  const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  const scene = (args: string[]) => runCloeScene(directory, args);
  const { data: traced } = await scene([
    "trace-webp", "reference.webp", "--native-detail", "--output", "cloe.scene.json",
  ]);
  expect(traced.sourceSha256).toBe(sha256(reference).slice("sha256:".length));
  let sceneFile = "cloe.scene.json";
  for (const [fixture, name] of [
    ["cloe-multiscale-edit.json", "line"],
    ["cloe-face-edit.json", "face"],
    ["cloe-seam-and-tablet-edit.json", "seams"],
    ["cloe-hair-and-satchel-edit.json", "hair-satchel"],
    ["cloe-trouser-and-shoe-edit.json", "trouser-shoe"],
    ["cloe-stylus-contour-edit.json", "stylus"],
    ["cloe-supporting-hand-edit.json", "hand"],
    ["cloe-chalkboard-network-edit.json", "chalkboard"],
  ] as const) {
    const edit = await readFile(new URL(`./fixtures/${fixture}`, import.meta.url));
    await writeFile(info.outputPath(`${name}-edit.json`), edit);
    const output = `${name}-refined.json`;
    await scene(["revise", sceneFile, "--edits", `${name}-edit.json`, "--output", output]);
    sceneFile = output;
  }
  async function exportFine(name: "seams" | "hair-satchel" | "trouser-shoe" | "stylus" | "hand" | "chalkboard") {
    const master = `${name}.svg`;
    await scene([
      "compile", `${name}-refined.json`, "--illustration-source", "--compact-paths", "--output", master,
    ]);
    const svgDigest = sha256(await readFile(info.outputPath(master)));
    const file = `${name}-fine.webp`;
    const { data } = await scene([
      "export-webp", master, "--expect-svg-digest", svgDigest,
      "--output-width", "512", "--quality", "96", "--sharp-chroma", "--output", file,
    ]);
    const bytes = await readFile(info.outputPath(file));
    expect(data).toMatchObject({
      svgDigest, rasterWidth: 1024, rasterHeight: 1536,
      recipe: {
        schemaVersion: 2, sourceSha256: data.pngDigest,
        output: { width: 512, height: 768, quality: 96, chroma: "sharp-yuv" },
      },
      receipt: { outputSha256: sha256(bytes), width: 512, height: 768 },
    });
    await page.route(`http://cloe.test/${file}`, route => route.fulfill({ contentType: "image/webp", body: bytes }));
    return { bytes, pngDigest: data.pngDigest };
  }
  const seam = await exportFine("seams");
  const contour = await exportFine("hair-satchel");
  expect(sha256(contour.bytes)).toBe("sha256:51db73e95567c2f18365a1d8ca6015ebdb4762f53922d12b4278e828aa19ea17");
  expect(contour.pngDigest).not.toBe(seam.pngDigest);
  expect(contour.bytes.byteLength).toBeLessThan(seam.bytes.byteLength * 1.01);
  const lower = await exportFine("trouser-shoe");
  expect(sha256(lower.bytes)).toBe("sha256:c46802c7b332f6cb3c406646ca9ce8aa084e2cd797dbeb3b75c145dcdc6c896e");
  expect(lower.pngDigest).not.toBe(contour.pngDigest);
  expect(lower.bytes.byteLength).toBeLessThan(contour.bytes.byteLength * 1.01);
  const stylus = await exportFine("stylus");
  expect(sha256(stylus.bytes)).toBe("sha256:9e33b828d1c8318a45dc3f35d616d565bb9c2746fb1184560c2566c961a58689");
  expect(stylus.pngDigest).not.toBe(lower.pngDigest);
  expect(stylus.bytes.byteLength).toBeLessThan(lower.bytes.byteLength);
  const hand = await exportFine("hand");
  expect(sha256(hand.bytes)).toBe("sha256:55a11407bdfc09fbd8005b9ee7799b2bdac1cc091ea0526e1f2b9fc9cfa50db2");
  expect(hand.pngDigest).not.toBe(stylus.pngDigest);
  expect(hand.bytes.byteLength).toBeLessThan(stylus.bytes.byteLength * 1.01);
  const chalkboard = await exportFine("chalkboard");
  expect(sha256(chalkboard.bytes)).toBe("sha256:52ccf2182d2844a2b8732aef68813a0252267b2a0c0ac7a8d03a2476a086a65d");
  expect(chalkboard.pngDigest).not.toBe(hand.pngDigest);
  expect(chalkboard.bytes.byteLength).toBeLessThan(hand.bytes.byteLength * 1.01);
  let lowerBodyGain = 0;
  for (const displayWidth of [384, 512]) {
    const height = displayWidth * 1.5;
    const src = await render(page, "/reference.webp", displayWidth, height);
    const before = await render(page, "/seams-fine.webp", displayWidth, height);
    const after = await render(page, "/hair-satchel-fine.webp", displayWidth, height);
    let combinedGain = 0;
    for (const [region, bounds] of Object.entries(cloeHairSatchelBounds(displayWidth))) {
      const gain = meanLineError(src, before, displayWidth, bounds) - meanLineError(src, after, displayWidth, bounds);
      // Small resampling differences can shift error between these two regions.
      expect(gain, `${displayWidth}px Fine Sharp ${region} edge gain`).toBeGreaterThan(-0.02);
      combinedGain += gain;
    }
    expect(combinedGain, `${displayWidth}px Fine Sharp combined edge gain`).toBeGreaterThan(0);
    const refined = await render(page, "/trouser-shoe-fine.webp", displayWidth, height);
    for (const [region, bounds] of Object.entries(cloeTrouserShoeBounds(displayWidth))) {
      const gain = meanLineError(src, after, displayWidth, bounds) - meanLineError(src, refined, displayWidth, bounds);
      expect(gain, `${displayWidth}px Fine Sharp ${region} edge gain`).toBeGreaterThan(-0.02);
      lowerBodyGain += gain;
    }
    const refinedStylus = await render(page, "/stylus-fine.webp", displayWidth, height);
    const stylusBounds = cloeStylusBounds(displayWidth);
    expect(meanLineError(src, refinedStylus, displayWidth, stylusBounds), `${displayWidth}px Fine Sharp stylus edge error`)
      .toBeLessThan(meanLineError(src, refined, displayWidth, stylusBounds));
    const refinedHand = await render(page, "/hand-fine.webp", displayWidth, height);
    const handBounds = cloeSupportingHandBounds(displayWidth);
    expect(meanLineError(src, refinedHand, displayWidth, handBounds), `${displayWidth}px Fine Sharp supporting hand edge error`)
      .toBeLessThan(meanLineError(src, refinedStylus, displayWidth, handBounds));
    const refinedChalkboard = await render(page, "/chalkboard-fine.webp", displayWidth, height);
    const chalkboardBounds = cloeChalkboardBounds(displayWidth);
    const beforeChalkboard = meanLineError(src, refinedHand, displayWidth, chalkboardBounds);
    const afterChalkboard = meanLineError(src, refinedChalkboard, displayWidth, chalkboardBounds);
    if (displayWidth === 512) {
      expect(afterChalkboard, "Native-size Fine Sharp chalkboard edge error").toBeLessThan(beforeChalkboard);
    } else {
      // Fractional downsampling can move individual lines by a subpixel.
      expect(afterChalkboard, "Resampled Fine Sharp chalkboard edge error").toBeLessThanOrEqual(beforeChalkboard + 0.015);
    }
  }
  expect(lowerBodyGain, "Fine Sharp lower-body edge gain across delivery sizes").toBeGreaterThan(0);
});

for (const detail of [null, "--high-detail", "--native-detail"] as const) {
  const fromSvg = detail !== null;
  const nativeDetail = detail === "--native-detail";
  test(fromSvg ? `Cloe WebP is exported from the full-body editable SVG (${detail})` : "Cloe's WebP export is repeatable and retains reference detail", async ({ page }, info) => {
    test.setTimeout(120_000);
    const capability = await probeMagickDerivativeCapability();
    if (!capability.available) throw new Error("This suite requires the TFSB WebP processor (ImageMagick with WebP support).");
    const referenceWebp = await loadCloeReference(page);
    const width = 1024, height = 1536;
    await mkdir(info.outputDir, { recursive: true });
    const directory = await realpath(info.outputDir);
    if (nativeDetail) {
      await writeFile(info.outputPath("reference.webp"), referenceWebp);
    } else {
      const referencePng = rgbaPng(width, height, await render(page, "/reference.webp", width, height));
      await writeFile(info.outputPath("reference.png"), referencePng);
    }
    const sourceFile = fromSvg ? "from-svg.png" : "reference.png";
    const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    let rasterReceipt: unknown;
    let traceReceipt: unknown;
    let directWebp: Buffer | undefined;
    if (fromSvg) {
      const scene = (args: string[], exitCode = 0) => runCloeScene(directory, args, exitCode);
      const traceArgs = nativeDetail
        ? ["trace-webp", "reference.webp", "--native-detail"]
        : ["trace-png", "reference.png"];
      const { data: traced } = await scene([...traceArgs, "--output", "cloe.scene.json"]);
      if (nativeDetail) {
        expect(traced).toMatchObject({
          action: "trace-webp",
          sourceSha256: sha256(referenceWebp).slice("sha256:".length),
          outputSha256: sha256(await readFile(info.outputPath("cloe.scene.json"))).slice("sha256:".length),
          decodedPngSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          decodeRecipeDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
        traceReceipt = traced;
      }
      const { data: compiled } = await scene(["compile", "cloe.scene.json", "--illustration-source", "--output", "cloe.svg"]);
      const svg = await readFile(info.outputPath("cloe.svg"));
      expect(svg.byteLength).toBeLessThan(16_000_000);
      expect(svg.toString()).toContain(nativeDetail ? 'viewBox="0 0 1024 1536"' : 'viewBox="0 0 768 1152"');
      expect(compiled.receipt.svgDigest).toBe(sha256(svg));
      const rasterSource = nativeDetail ? ["cloe.svg", "--svg-source"] : ["cloe.scene.json"];
      if (nativeDetail) {
        const refusal = await scene([
          "rasterize", ...rasterSource, "--output", "refused.png", "--expect-svg-digest", sha256(Buffer.alloc(0)),
        ], 1);
        expect(refusal.diagnostics[0].code).toBe("SCENE_RASTER_SVG_DIGEST_MISMATCH");
        expect(refusal.data).toBeNull();
        await expect(readFile(info.outputPath("refused.png"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      const { data: rasterized } = await scene([
        "rasterize", ...rasterSource, "--output", sourceFile, "--expect-svg-digest", compiled.receipt.svgDigest,
      ]);
      expect(rasterized).toMatchObject({
        width, height, svgDigest: sha256(svg), pngDigest: sha256(await readFile(info.outputPath(sourceFile))),
        rendererBuildDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      if (nativeDetail) {
        const before = await readdir(directory);
        const { data: direct } = await scene([
          "export-webp", "cloe.svg", "--output", "direct.webp", "--expect-svg-digest", sha256(svg),
        ]);
        directWebp = await readFile(info.outputPath("direct.webp"));
        expect((await readdir(directory)).sort()).toEqual([...before, "direct.webp"].sort());
        expect(direct).toMatchObject({
          svgDigest: rasterized.svgDigest, pngDigest: rasterized.pngDigest,
          rendererBuildDigest: rasterized.rendererBuildDigest, rasterWidth: width, rasterHeight: height,
          recipe: { sourceSha256: rasterized.pngDigest, output: { width, height, quality: 94 } },
          receipt: { sourceSha256: rasterized.pngDigest, outputSha256: sha256(directWebp), mime: "image/webp" },
        });
        expect(direct.receipt.recipeDigest).toBe(direct.recipe.recipeDigest);
        const { data: narrow } = await scene([
          "export-webp", "cloe.svg", "--output", "responsive.webp", "--expect-svg-digest", sha256(svg),
          "--output-width", "512",
        ]);
        const narrowWebp = await readFile(info.outputPath("responsive.webp"));
        expect(narrow).toMatchObject({
          svgDigest: direct.svgDigest, pngDigest: direct.pngDigest,
          rendererBuildDigest: direct.rendererBuildDigest, rasterWidth: width, rasterHeight: height,
          recipe: { sourceSha256: direct.pngDigest, output: { width: 512, height: 768, quality: 94 } },
          receipt: { width: 512, height: 768, outputSha256: sha256(narrowWebp), mime: "image/webp" },
        });
        expect(narrow.receipt.recipeDigest).toBe(narrow.recipe.recipeDigest);
        expect(narrow.recipe.recipeDigest).not.toBe(direct.recipe.recipeDigest);
        const areaArgs = [
          "export-webp", "cloe.svg", "--expect-svg-digest", sha256(svg),
          "--output-width", "384", "--resample", "area",
        ];
        const { data: area } = await scene([...areaArgs, "--output", "area.webp"]);
        const areaWebp = await readFile(info.outputPath("area.webp"));
        expect(area).toMatchObject({
          svgDigest: rasterized.svgDigest, pngDigest: rasterized.pngDigest,
          rendererBuildDigest: rasterized.rendererBuildDigest, rasterWidth: width, rasterHeight: height,
          recipe: {
            schemaVersion: 3, sourceSha256: rasterized.pngDigest, sourceWidth: width, sourceHeight: height,
            output: { width: 384, height: 576, resample: "area-srgb-alpha-weighted-v1", chroma: "sharp-yuv" },
          },
          receipt: { width: 384, height: 576, outputSha256: sha256(areaWebp) },
        });
        expect(area.receipt.recipeDigest).toBe(area.recipe.recipeDigest);
        const { data: areaRepeat } = await scene([...areaArgs, "--output", "area-repeat.webp"]);
        expect(areaRepeat.receipt).toEqual(area.receipt);
        expect(await readFile(info.outputPath("area-repeat.webp"))).toEqual(areaWebp);
        expect(await readFile(info.outputPath("cloe.svg"))).toEqual(svg);
        await page.route("http://cloe.test/area.webp", route =>
          route.fulfill({ contentType: "image/webp", body: areaWebp }));
        const areaPixels = await render(page, "/area.webp", 384, 576);
        const areaReference = await render(page, "/reference.webp", 384, 576);
        const areaErrors = compareCloe(areaReference, areaPixels, 384, 576);
        for (const [region, { mean, severe }] of Object.entries(areaErrors)) {
          expect(mean, `Area 384px ${region} mean RGB error`).toBeLessThan(13);
          expect(severe, `Area 384px ${region} large-error rate`).toBeLessThan(0.08);
        }
        await info.attach("area-webp-receipt-chain.json", {
          body: JSON.stringify({ raster: rasterized, recipe: area.recipe, derivative: area.receipt, errors: areaErrors }),
          contentType: "application/json",
        });
        const clobber = await scene([
          "export-webp", "cloe.svg", "--output", "direct.webp", "--expect-svg-digest", sha256(svg),
        ], 1);
        expect(clobber).toMatchObject({ data: null, diagnostics: [{ code: "SCENE_WEBP_OUTPUT_TARGET_EXISTS" }] });
        expect((await readFile(info.outputPath("direct.webp"))).equals(directWebp)).toBe(true);
      }
      rasterReceipt = rasterized;
      await page.route("http://cloe.test/svg-render.png", async (route) =>
        route.fulfill({ contentType: "image/png", body: await readFile(info.outputPath(sourceFile)) }));
    }
    const source = await readFile(info.outputPath(sourceFile));
    const sourceSha256 = sha256(source);
    const recipe = createRasterDerivativeRecipe({
      recipeId: nativeDetail ? "cloe-native-svg-webp" : fromSvg ? "cloe-svg-webp-fidelity" : "cloe-webp-fidelity",
      recipeRevision: 1,
      sourceSha256,
      sourceMime: "image/png",
      processor: capability.processor,
      output: {
        mime: "image/webp", width, height, fit: "contain-pad", colorSpace: "srgb",
        metadata: "stripped", alpha: "preserve", quality: fromSvg ? 94 : 90, method: 6, filter: "Lanczos",
      },
    });
    await writeFile(info.outputPath("recipe.json"), JSON.stringify(recipe));

    async function exportWebp(output: string, recipePath = "recipe.json", exitCode = 0) {
      let stdout = "", stderr = "";
      const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
      const status = await runIllustrationCli(
        ["export", "--recipe", recipePath, "--source", sourceFile, "--output", output, "--json"], directory, io,
      );
      expect(status, stdout + stderr).toBe(exitCode);
      return JSON.parse(stdout).data;
    }

    if (nativeDetail) {
      const stale = createRasterDerivativeRecipe({
        recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision,
        sourceSha256: sha256(Buffer.alloc(0)), sourceMime: recipe.sourceMime,
        processor: recipe.processor, output: recipe.output,
      });
      await writeFile(info.outputPath("stale-recipe.json"), JSON.stringify(stale));
      expect(await exportWebp("refused.webp", "stale-recipe.json", 1)).toEqual({ failureCode: "SOURCE_CHECKSUM_MISMATCH" });
      await expect(readFile(info.outputPath("refused.webp"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    async function verifiedExport(output: string) {
      const receipt = await exportWebp(output);
      const bytes = await readFile(info.outputPath(output));
      expect(receipt).toMatchObject({
        sourceSha256, recipeDigest: recipe.recipeDigest, width, height,
        verification: "processor-decoded-dimensions",
        outputSha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      });
      return { bytes, receipt };
    }

    const { bytes: webp, receipt } = await verifiedExport("cloe.webp");
    const repeat = await verifiedExport("cloe-repeat.webp");
    expect(repeat.bytes.equals(webp)).toBe(true);
    expect(repeat.receipt).toEqual(receipt);
    if (directWebp !== undefined) expect(directWebp.equals(webp)).toBe(true);
    if (fromSvg) {
      await info.attach("svg-webp-receipt-chain.json", {
        body: JSON.stringify({ trace: traceReceipt, raster: rasterReceipt, derivative: receipt }), contentType: "application/json",
      });
    }
    expect(webp.length).toBeLessThan(500_000);
    await page.route("http://cloe.test/cloe.webp", (route) =>
      route.fulfill({ contentType: "image/webp", body: webp }));

    for (const displayWidth of [1024, 768, 512, 384, 336, 256]) {
      const displayHeight = displayWidth * 1.5;
      const before = await render(page, "/reference.webp", displayWidth, displayHeight);
      const after = await render(page, "/cloe.webp", displayWidth, displayHeight);
      const errors = compareCloe(before, after, displayWidth, displayHeight);
      if (fromSvg) {
        const svgRaster = await render(page, "/svg-render.png", displayWidth, displayHeight);
        const encoding = compareCloe(svgRaster, after, displayWidth, displayHeight);
        for (const [region, { mean }] of Object.entries(encoding)) {
          expect(mean, `${displayWidth}px ${region} encoding error`).toBeLessThan(3);
        }
        await info.attach(`webp-encoding-errors-${displayWidth}.json`, {
          body: JSON.stringify(encoding), contentType: "application/json",
        });
      }
      await info.attach(`webp-errors-${displayWidth}.json`, { body: JSON.stringify(errors), contentType: "application/json" });
      for (const [region, { mean, severe }] of Object.entries(errors)) {
        expect(mean, `${displayWidth}px ${region} mean RGB error`).toBeLessThan(fromSvg ? 13 : 2.25);
        expect(severe, `${displayWidth}px ${region} large-error rate`).toBeLessThan(fromSvg ? 0.08 : 0.002);
      }
    }
  });
}

const transparentArt = [
  {
    title: "Hikari reserves editable elements and exports the subgroup without altering alpha",
    referenceFile: "hikari-original-site.webp",
    editFile: "hikari-needlework-edit.json",
    referenceDigest: "sha256:79f3fb675f2644069d6a3d5aa6a3a19d61c313e7691cb638c830c5f857cb5c23",
    groupId: "uniform-needlework-refinement",
    additions: 125,
    reserveElements: 125,
    region: [211, 280, 307, 480] as const,
    expected: undefined,
  },
  {
    title: "Rei Ai reopens the tablet edit and exports both WebP sizes without altering alpha",
    referenceFile: "rei-ai-original-site.webp",
    editFile: "rei-ai-tablet-edit.json",
    referenceDigest: "sha256:c5e09f5cb7cc83b5df159467d853d6627c4de27f9dd87db06a71a57dabbbfe1d",
    groupId: "tablet-line-refinement",
    additions: 116,
    reserveElements: 125,
    expected: {
      nativeRegion: [664, 216, 824, 379] as const,
      svg: "sha256:e257463553896bb04d0afefc617c6326fb7c38a72e33e0ec523f019e5ba5333d",
      mobile: "sha256:e1e98ee6804c439b50949002893719429631f8e0c10f5da4d6850631a2d15afb",
      full: "sha256:1d03f3f22d922708b24f64651515fb28ec95e58eae4026598ab626de3defbde7",
    },
  },
  {
    title: "Shiori reopens the grimoire edit and exports both WebP sizes without altering alpha",
    referenceFile: "shiori-original-site.webp",
    editFile: "shiori-grimoire-edit.json",
    referenceDigest: "sha256:1232c9de2fe441aae6586937aad627c591f7d3db21c34145140342b2d6c920b8",
    groupId: "grimoire-metalwork-refinement",
    additions: 26,
    reserveElements: 26,
    expected: {
      nativeRegion: [570, 318, 875, 512] as const,
      svg: "sha256:b592cd7412f07e544dd9351c89a42956aec8c62f02faa5e6bba7e5d0f74f84c8",
      mobile: "sha256:e094a346963e8cd9b745adb062a4e790be1a488c251dced43686abad80fe9e56",
      full: "sha256:b0b7432edb1fa38d372b032a6deb9043a7acecc4886a79ca512d5eb7a237818b",
    },
  },
];

for (const art of transparentArt) {
  test(art.title, async ({ page }, info) => {
    test.setTimeout(120_000);
    const reference = await readFile(new URL(`./fixtures/${art.referenceFile}`, import.meta.url));
    const edit = await readFile(new URL(`./fixtures/${art.editFile}`, import.meta.url));
    const hash = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
    expect(hash(reference)).toBe(art.referenceDigest);
    await mkdir(info.outputDir, { recursive: true });
    const directory = await realpath(info.outputDir);
    await writeFile(info.outputPath("reference.webp"), reference);
    await writeFile(info.outputPath("edit.json"), edit);
    async function scene(args: string[]) {
      let stdout = "", stderr = "";
      const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
      expect(await runSceneCli([...args, "--json"], directory, io), stdout + stderr).toBe(0);
      return JSON.parse(stdout).data;
    }
    const outputArgs = ["--compact-paths", "--illustration-source"];
    const reservation = ["--reserve-elements", String(art.reserveElements)];
    await scene(["trace-webp", "reference.webp", "--native-detail", "--preserve-alpha", ...reservation, "--output", "reserved.json"]);
    const { metrics: reserved } = await scene(["inspect", "reserved.json"]);
    expect(reserved.authoredElementCount).toBeLessThanOrEqual(2_000 - Math.max(art.reserveElements, art.additions));
    await scene(["revise", "reserved.json", "--edits", "edit.json", "--output", "edited.json"]);
    const { metrics: edited } = await scene(["inspect", "edited.json"]);
    expect(edited.authoredElementCount - reserved.authoredElementCount).toBe(art.additions);
    await scene(["compile", "reserved.json", ...outputArgs, "--output", "reserved.svg"]);
    await scene(["compile", "edited.json", ...outputArgs, "--output", "edited.svg"]);
    const before = await readFile(info.outputPath("reserved.svg"));
    const after = await readFile(info.outputPath("edited.svg"));
    expect(after.byteLength).toBeLessThanOrEqual(16_000_000);
    expect(after.toString()).toContain('viewBox="0 0 1024 1536"');
    expect(after.toString()).toContain(`id="${art.groupId}"`);
    const binding = ["--expect-svg-digest", hash(after)];
    await scene(["import-svg", "edited.svg", "--svg-source", ...binding, "--output", "reopened.json"]);
    await scene(["compile", "reopened.json", ...outputArgs, "--output", "reopened.svg"]);
    expect((await readFile(info.outputPath("reopened.svg"))).equals(after)).toBe(true);
    await writeFile(info.outputPath("remove-edit.json"), JSON.stringify({
      parentGroupId: "trace-near-opaque", removeGroup: art.groupId,
    }));
    await scene(["revise", "reopened.json", "--edits", "remove-edit.json", "--output", "restored.json"]);
    await scene(["compile", "restored.json", ...outputArgs, "--output", "restored.svg"]);
    expect((await readFile(info.outputPath("restored.svg"))).equals(before)).toBe(true);

    await scene(["rasterize", "reserved.svg", "--svg-source", "--expect-svg-digest", hash(before), "--output", "reserved.png"]);
    const raster = await scene(["rasterize", "edited.svg", "--svg-source", ...binding, "--output", "edited.png"]);
    const responsive = ["--output-width", "512", "--quality", "96", "--sharp-chroma"];
    await scene(["export-webp", "reserved.svg", "--expect-svg-digest", hash(before), ...responsive, "--output", "reserved.webp"]);
    const first = await scene(["export-webp", "edited.svg", ...binding, ...responsive, "--output", "edited.webp"]);
    const second = await scene(["export-webp", "edited.svg", ...binding, ...responsive, "--output", "repeat.webp"]);
    const webp = await readFile(info.outputPath("edited.webp"));
    expect((await readFile(info.outputPath("repeat.webp"))).equals(webp)).toBe(true);
    expect(second.receipt).toEqual(first.receipt);
    expect(first.receipt).toMatchObject({
      sourceSha256: raster.pngDigest, outputSha256: hash(webp), width: 512, height: 768, alpha: "has-alpha",
    });

    if (art.expected) {
      expect(hash(after)).toBe(art.expected.svg);
      expect(hash(webp)).toBe(art.expected.mobile);
      await scene(["export-webp", "reserved.svg", "--expect-svg-digest", hash(before),
        "--quality", "94", "--output", "reserved-full.webp"]);
      const fullArgs = ["export-webp", "reopened.svg", ...binding, "--quality", "94"];
      const full = await scene([...fullArgs, "--output", "full.webp"]);
      const repeatFull = await scene([...fullArgs, "--output", "repeat-full.webp"]);
      const fullWebp = await readFile(info.outputPath("full.webp"));
      expect(hash(fullWebp)).toBe(art.expected.full);
      expect((await readFile(info.outputPath("repeat-full.webp"))).equals(fullWebp)).toBe(true);
      expect(repeatFull.receipt).toEqual(full.receipt);
      expect(full.receipt).toMatchObject({
        sourceSha256: raster.pngDigest, outputSha256: hash(fullWebp), width: 1024, height: 1536, alpha: "has-alpha",
      });
    }

    const origin = "http://transparent-art.test";
    await page.route(origin + "/", route => route.fulfill({
      contentType: "text/html", body: "<!doctype html><title>Transparent illustration fixture</title>",
    }));
    await page.route(origin + "/reference.webp", route => route.fulfill({ contentType: "image/webp", body: reference }));
    const comparedExports = art.expected ? ["reserved-full.webp", "full.webp"] : ["reserved.webp", "edited.webp"];
    for (const name of ["reserved.png", "edited.png", ...comparedExports]) {
      const body = await readFile(info.outputPath(name));
      await page.route(origin + "/" + name, route => route.fulfill({
        contentType: name.endsWith(".png") ? "image/png" : "image/webp", body,
      }));
    }
    await page.goto(origin + "/");
    const masterBefore = await render(page, "/reserved.png", 1024, 1536, null);
    const masterAfter = await render(page, "/edited.png", 1024, 1536, null);
    expect(alphaMeanError(masterBefore, masterAfter)).toBe(0);
    expect(masterAfter.equals(masterBefore)).toBe(false);
    if (art.expected) {
      const { nativeRegion } = art.expected;
      const nativeReference = await render(page, "/reference.webp", 1024, 1536);
      const score = async (path: string) => meanLineError(
        nativeReference, await render(page, path, 1024, 1536), 1024, nativeRegion,
      );
      const scores = {
        svgBefore: await score("/reserved.png"), svgAfter: await score("/edited.png"),
        webpBefore: await score("/reserved-full.webp"), webpAfter: await score("/full.webp"),
      };
      await info.attach("native-edge-error.json", { body: JSON.stringify(scores), contentType: "application/json" });
      expect(scores.svgAfter, "edited-region edge error in the SVG render").toBeLessThan(scores.svgBefore);
      expect(scores.webpAfter, "edited-region edge error in the full-size WebP").toBeLessThan(scores.webpBefore);
    } else {
      const referenceMobile = await render(page, "/reference.webp", 384, 576);
      const exportBefore = await render(page, "/reserved.webp", 384, 576);
      const exportAfter = await render(page, "/edited.webp", 384, 576);
      const originalError = meanLineError(referenceMobile, exportBefore, 384, art.region);
      const refinedError = meanLineError(referenceMobile, exportAfter, 384, art.region);
      expect(refinedError, "mobile embroidery edge error").toBeLessThan(originalError);
    }
  });
}
