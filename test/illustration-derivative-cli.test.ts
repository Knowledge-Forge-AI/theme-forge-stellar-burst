import { deflateSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeSha256 } from "../src/digests.js";
import {
  canonicalRasterDerivativeRecipeJson,
  createRasterDerivativeRecipe,
  type ImageMagickProcessorDescriptorV1,
  type RasterDerivativeOutputV1,
  type RasterDerivativeRecipeV1,
} from "../src/illustration/derivative.js";
import {
  runIllustrationDerivativeCli,
  type IllustrationDerivativeCliIo,
  type IllustrationDerivativeCliRuntime,
} from "../src/illustration/derivative-cli.js";

const encoder = new TextEncoder();
let root = "";

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = encoder.encode(type);
  const crcInput = Buffer.concat([Buffer.from(typeBytes), Buffer.from(data)]);
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  Buffer.from(typeBytes).copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(crcInput), 8 + data.byteLength);
  return chunk;
}

function tinyPng(): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Uint8Array.of(0, 240, 32, 16, 128))),
    pngChunk("IEND", new Uint8Array()),
  ]));
}

function processor(): ImageMagickProcessorDescriptorV1 {
  return { kind: "imagemagick", executable: "magick", version: "7.1.2-cli-test", binarySha256: null, closureSha256: null, identityScope: "same-host-version-only" };
}

function recipe(source: Uint8Array): RasterDerivativeRecipeV1 {
  return createRasterDerivativeRecipe({
    recipeId: "cli-preview",
    recipeRevision: 1,
    sourceSha256: computeSha256(source),
    sourceMime: "image/png",
    output: { mime: "image/png", width: 8, height: 8, fit: "contain-pad", colorSpace: "srgb", metadata: "stripped", alpha: "preserve", quality: 90, method: 4, filter: "Lanczos" },
    processor: processor(),
  });
}

function capture(): IllustrationDerivativeCliIo & { readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
}

function runtime(calls: { count: number }): IllustrationDerivativeCliRuntime {
  return {
    render: async (source, value): Promise<RasterDerivativeOutputV1> => {
      calls.count += 1;
      const bytes = Uint8Array.of(1, 2, 3, 4, 5);
      return Object.freeze({
        sourceSha256: value.sourceSha256,
        recipeDigest: value.recipeDigest,
        processor: value.processor,
        mime: value.output.mime,
        bytes,
        sha256: computeSha256(bytes),
        byteLength: bytes.byteLength,
        width: value.output.width,
        height: value.output.height,
        alpha: "has-alpha",
        verification: "png-pixels-decoded",
      });
    },
  };
}

async function prepareFiles(value = recipe(tinyPng())): Promise<{ readonly recipePath: string; readonly sourcePath: string; readonly source: Uint8Array; readonly recipe: RasterDerivativeRecipeV1 }> {
  const source = tinyPng();
  const sourcePath = join(root, "source.png");
  const recipePath = join(root, "recipe.json");
  const actualRecipe = value.sourceSha256 === computeSha256(source) ? value : recipe(source);
  await writeFile(sourcePath, source, { mode: 0o600 });
  await writeFile(recipePath, canonicalRasterDerivativeRecipeJson(actualRecipe), { mode: 0o600 });
  return { recipePath, sourcePath, source, recipe: actualRecipe };
}

function json(io: IllustrationDerivativeCliIo & { readonly out: string[] }): Record<string, unknown> {
  return JSON.parse(io.out.join("")) as Record<string, unknown>;
}

describe("standalone illustration derivative CLI", () => {
  beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), "tfsb-derivative-cli-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("reports capability through the real fixed processor without exposing paths", async () => {
    const io = capture();
    const code = await runIllustrationDerivativeCli(["capability", "--json"], root, io);
    expect(code).toBe(0);
    const result = json(io);
    expect(result.schema).toBe("tfsb.illustration-derivative-result");
    expect(result.command).toBe("capability");
    expect(result.state === "available" || result.state === "unavailable").toBe(true);
    expect(io.out.join("")).not.toContain(root);
    expect(io.out.join("")).not.toContain("/");
  });

  it("exports through the explicit seam, creates a private absent target, and emits a path-free receipt", async () => {
    const files = await prepareFiles();
    const calls = { count: 0 };
    const io = capture();
    const outputPath = join(root, "out.png");
    const code = await runIllustrationDerivativeCli(["export", "--recipe", "recipe.json", "--source", "source.png", "--output", "out.png", "--json"], root, io, runtime(calls));
    expect(code).toBe(0);
    expect(calls.count).toBe(1);
    const result = json(io);
    expect(result.state).toBe("completed");
    const receipt = result.data as Record<string, unknown>;
    expect(receipt.sourceSha256).toBe(files.recipe.sourceSha256);
    expect(receipt.recipeDigest).toBe(files.recipe.recipeDigest);
    expect(receipt.outputSha256).toBe(computeSha256(Uint8Array.of(1, 2, 3, 4, 5)));
    expect(receipt.width).toBe(8);
    expect(receipt.height).toBe(8);
    expect(receipt.alpha).toBe("has-alpha");
    expect(receipt.verification).toBe("png-pixels-decoded");
    expect(receipt.processor).toEqual({ identityScope: "same-host-version-only" });
    expect(io.out.join("")).not.toContain(root);
    expect(io.out.join("")).not.toContain("Illustration derivative operation failed");
    expect(await readFile(outputPath)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    const outputStat = await stat(outputPath);
    expect(outputStat.mode & 0o777).toBe(0o600);
    expect(outputStat.nlink).toBe(1);
    if (typeof process.getuid === "function") expect(outputStat.uid).toBe(process.getuid());
  });

  it("refuses existing outputs before rendering and never overwrites their bytes", async () => {
    await prepareFiles();
    const outputPath = join(root, "out.png");
    await writeFile(outputPath, Buffer.from("existing"), { mode: 0o600 });
    const calls = { count: 0 };
    const io = capture();
    const code = await runIllustrationDerivativeCli(["export", "--recipe=recipe.json", "--source=source.png", "--output=out.png", "--json"], root, io, runtime(calls));
    expect(code).toBe(1);
    expect(calls.count).toBe(0);
    expect((json(io).data as Record<string, unknown>).failureCode).toBe("OUTPUT_TARGET_EXISTS");
    expect(await readFile(outputPath)).toEqual(Buffer.from("existing"));
  });

  it("rejects an adapter digest mismatch before creating an output", async () => {
    await prepareFiles();
    const base = runtime({ count: 0 });
    const io = capture();
    const outputPath = join(root, "tampered.png");
    const code = await runIllustrationDerivativeCli(
      ["export", "--recipe", "recipe.json", "--source", "source.png", "--output", "tampered.png", "--json"],
      root,
      io,
      { render: async (source, value) => ({ ...(await base.render!(source, value)), sha256: computeSha256(Uint8Array.of(9)) }) },
    );
    expect(code).toBe(1);
    expect((json(io).data as Record<string, unknown>).failureCode).toBe("OUTPUT_INVALID");
    await expect(stat(outputPath)).rejects.toBeDefined();
  });

  it("classifies an adapter recipe digest mismatch as output invalid", async () => {
    await prepareFiles();
    const base = runtime({ count: 0 });
    const io = capture();
    const outputPath = join(root, "recipe-tampered.png");
    const code = await runIllustrationDerivativeCli(
      ["export", "--recipe", "recipe.json", "--source", "source.png", "--output", "recipe-tampered.png", "--json"],
      root,
      io,
      { render: async (source, value) => ({ ...(await base.render!(source, value)), recipeDigest: computeSha256(Uint8Array.of(8)) }) },
    );
    expect(code).toBe(1);
    expect((json(io).data as Record<string, unknown>).failureCode).toBe("OUTPUT_INVALID");
    await expect(stat(outputPath)).rejects.toBeDefined();
  });

  it("maps unknown adapter error codes to INTERNAL_ERROR", async () => {
    await prepareFiles();
    const io = capture();
    const code = await runIllustrationDerivativeCli(
      ["export", "--recipe", "recipe.json", "--source", "source.png", "--output", "unknown-error.png", "--json"],
      root,
      io,
      { render: async () => { throw Object.assign(new Error("not public"), { code: "ERR_PRIVATE_DETAIL" }); } },
    );
    expect(code).toBe(1);
    expect((json(io).data as Record<string, unknown>).failureCode).toBe("INTERNAL_ERROR");
    expect(io.out.join("")).not.toContain("not public");
  });

  it("rejects source, output-parent, and output-target symlink boundaries", async () => {
    if (process.platform === "win32") return;
    const files = await prepareFiles();
    const calls = { count: 0 };
    await symlink(files.sourcePath, join(root, "source-link.png"));
    const sourceIo = capture();
    const sourceCode = await runIllustrationDerivativeCli(["export", "--recipe", "recipe.json", "--source", "source-link.png", "--output", "new.png", "--json"], root, sourceIo, runtime(calls));
    expect(sourceCode).toBe(1);
    expect((json(sourceIo).data as Record<string, unknown>).failureCode).toBe("SOURCE_INPUT_INVALID");

    const realParent = join(root, "real-parent");
    await mkdir(realParent);
    await symlink(realParent, join(root, "parent-link"));
    const parentIo = capture();
    const parentCode = await runIllustrationDerivativeCli(["export", "--recipe", "recipe.json", "--source", "source.png", "--output", "parent-link/out.png", "--json"], root, parentIo, runtime(calls));
    expect(parentCode).toBe(1);
    expect((json(parentIo).data as Record<string, unknown>).failureCode).toBe("OUTPUT_TARGET_INVALID");

    const existingTarget = join(root, "target.png");
    await writeFile(existingTarget, Buffer.from("target"), { mode: 0o600 });
    await symlink(existingTarget, join(root, "target-link.png"));
    const targetIo = capture();
    const targetCode = await runIllustrationDerivativeCli(["export", "--recipe", "recipe.json", "--source", "source.png", "--output", "target-link.png", "--json"], root, targetIo, runtime(calls));
    expect(targetCode).toBe(1);
    expect((json(targetIo).data as Record<string, unknown>).failureCode).toBe("OUTPUT_TARGET_EXISTS");
    expect(await readFile(existingTarget)).toEqual(Buffer.from("target"));
  });

  it("rejects duplicate keys, BOM, malformed UTF-8, missing parents, and unknown options without raw errors", async () => {
    const files = await prepareFiles();
    const cases: readonly [string, Uint8Array][] = [
      ["duplicate", encoder.encode('{"schema":"x","schema":"y"}')],
      ["bom", new Uint8Array([...Uint8Array.of(0xef, 0xbb, 0xbf), ...encoder.encode(canonicalRasterDerivativeRecipeJson(files.recipe))])],
      ["utf8", Uint8Array.of(0xc3, 0x28)],
    ];
    for (const [name, bytes] of cases) {
      const recipePath = join(root, `${name}.json`);
      await writeFile(recipePath, bytes, { mode: 0o600 });
      const io = capture();
      const code = await runIllustrationDerivativeCli(["export", "--recipe", recipePath, "--source", files.sourcePath, "--output", `${name}.png`, "--json"], root, io, runtime({ count: 0 }));
      expect(code).toBe(1);
      expect((json(io).data as Record<string, unknown>).failureCode).toBe("RECIPE_INPUT_INVALID");
      expect(io.out.join("")).not.toContain(root);
    }
    const missingParentIo = capture();
    const missingParentCode = await runIllustrationDerivativeCli(["export", "--recipe", "recipe.json", "--source", "source.png", "--output", "missing/out.png", "--json"], root, missingParentIo, runtime({ count: 0 }));
    expect(missingParentCode).toBe(1);
    expect((json(missingParentIo).data as Record<string, unknown>).failureCode).toBe("OUTPUT_TARGET_INVALID");
    const invalidIo = capture();
    expect(await runIllustrationDerivativeCli(["export", "--recipe", "recipe.json", "--source", "source.png", "--output", "missing/out.png", "--unknown", "--json"], root, invalidIo)).toBe(1);
  });

  it("rejects repeated and unsupported command options", async () => {
    const io = capture();
    expect(await runIllustrationDerivativeCli(["capability", "--json", "--json"], root, io)).toBe(1);
    expect(await runIllustrationDerivativeCli(["export", "--json", "--json"], root, io)).toBe(1);
    expect(await runIllustrationDerivativeCli(["export", "--recipe", "recipe.json", "--source", "source.png", "--output", "x.png", "--force", "--json"], root, io)).toBe(1);
  });

});
