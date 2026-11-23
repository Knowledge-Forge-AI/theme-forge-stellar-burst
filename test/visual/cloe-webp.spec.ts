import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { runSceneCli } from "../../src/scene-cli.js";
import { runIllustrationCli } from "../../src/illustration-cli.js";
import { createRasterDerivativeRecipe, probeMagickDerivativeCapability } from "../../src/illustration/derivative.js";
import { rgbaPng } from "../brand/raster-test-helper.js";
import { alphaMeanError, compare, compareCloe, loadCloeReference, loadOrihimeReference, orihimeRegions, render } from "./cloe-visual-helpers.js";

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
  const { data: traced } = await scene(["trace-webp", "reference.webp", "--native-detail", "--preserve-alpha", "--output", "orihime.json"]);
  expect(traced).toMatchObject({
    action: "trace-webp",
    sourceSha256: sha256(referenceWebp).slice("sha256:".length),
    outputSha256: sha256(await readFile(info.outputPath("orihime.json"))).slice("sha256:".length),
    decodedPngSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    decodeRecipeDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
  });
  await scene(["compile", "orihime.json", "--output", "orihime.svg"]);
  const svg = await readFile(info.outputPath("orihime.svg"));
  expect(svg.byteLength).toBeLessThanOrEqual(16_000_000);
  expect(svg.toString("utf8")).toContain('viewBox="0 0 1024 1536"');
  const binding = ["--expect-svg-digest", sha256(svg)];
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
    body: JSON.stringify({ svgBytes: svg.byteLength, webpBytes: webp.length, receipt: first.receipt, metrics }),
    contentType: "application/json",
  });
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
      async function scene(args: string[], exitCode = 0) {
        let stdout = "", stderr = "";
        const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
        expect(await runSceneCli([...args, "--json"], directory, io), stdout + stderr).toBe(exitCode);
        return JSON.parse(stdout);
      }
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
