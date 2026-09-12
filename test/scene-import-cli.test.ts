import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { runSceneCli } from "../src/scene-cli.js";
import { publishSceneJson, readSceneFileBytes } from "../src/scene-files.js";
import { compileScene, sceneImportSvg, validateScene } from "../src/scene/index.js";
import type { JsonResultEnvelope, SceneJsonData, SceneImportSvgJsonData } from "../src/json.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function makeTestDir(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "tfsb-scene-import-cli-")));
  roots.push(dir);
  return dir;
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// Original first-party synthetic SVG fixtures (no copied third-party corpus art)
const validShapeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="10" y="10" width="80" height="60" rx="4" fill="#4A90E2"/>
  <circle cx="50" cy="50" r="20" fill="#E24A90"/>
</svg>`;

const validPathSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <path d="M10 10 L50 10 L30 50 Z" fill="#333333"/>
</svg>`;

const unsafeScriptSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <script>alert("test")</script>
  <rect width="10" height="10" fill="#000000"/>
</svg>`;

const unsafeForeignObjectSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <foreignObject width="20" height="20"><span>unsafe</span></foreignObject>
  <rect width="10" height="10" fill="#000000"/>
</svg>`;

const externalHrefSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <use href="https://example.invalid/external.svg#icon"/>
  <rect width="10" height="10" fill="#000000"/>
</svg>`;

const unsupportedClassSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect class="unsupported-class-styling" width="10" height="10" fill="#000000"/>
</svg>`;

const unsupportedTextSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <text x="5" y="20">Unsupported text element</text>
</svg>`;

describe("tfsb scene import-svg CLI", () => {
  describe("success and determinism", () => {
    it("imports a valid SVG to absent scene JSON in human mode", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      const outputJson = join(dir, "scene.json");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(["scene", "import-svg", inputSvg, "--output", outputJson], dir, cap.io);

      expect(exitCode).toBe(0);
      expect(cap.stdout()).toContain("Imported scene:");
      const normalizations = sceneImportSvg(Buffer.from(validShapeSvg)).normalizations!;
      expect(normalizations.length).toBeGreaterThan(0);
      for (const normalization of normalizations) {
        expect(cap.stdout()).toContain(`normalization: ${normalization}`);
      }
      expect(cap.stdout()).toContain("scene.json");
      expect(cap.stdout()).toContain("source sha256:");
      expect(cap.stderr()).toBe("");

      const content = await readFile(outputJson, "utf8");
      expect(content.length).toBeGreaterThan(0);
      const parsed = JSON.parse(content);
      expect(parsed.schema).toBe("tfsb.vector-scene-v1");
      expect(validateScene(parsed).ok).toBe(true);
    });

    it("imports a valid SVG with machine JSON envelope (--json)", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      const outputJson = join(dir, "output.json");
      await writeFile(inputSvg, validPathSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", "output.json", "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(0);
      expect(cap.stderr()).toBe("");

      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneImportSvgJsonData>;
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.command).toBe("scene");
      expect(envelope.status).toBe("ok");
      expect(envelope.exitCode).toBe(0);
      expect(envelope.diagnostics).toEqual([]);
      expect(envelope.data).not.toBeNull();
      expect(envelope.data?.schema).toBe("tfsb.scene-result-v1");
      expect(envelope.data?.action).toBe("import-svg");
      expect(envelope.data?.classification).toBe("SUPPORTED_IMPORT");
      expect(envelope.data?.reasons).toEqual([]);
      expect(envelope.data?.written).toBe(true);
      expect(envelope.data?.sourceSha256).toBe(`sha256:${sha256(validPathSvg)}`);
      expect(Array.isArray(envelope.data?.normalizations)).toBe(true);
      // Ensure no raw payload or private absolute paths in envelope data
      expect((envelope.data as any).scene).toBeUndefined();
      expect(envelope.data?.output).toBe("output.json");

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it("produces byte-identical JSON on repeated imports to two destinations", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      const dest1 = join(dir, "dest1.json");
      const dest2 = join(dir, "dest2.json");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      const cap1 = capture();
      const code1 = await runCli(["scene", "import-svg", inputSvg, "--output", dest1, "--json"], dir, cap1.io);
      expect(code1).toBe(0);

      const cap2 = capture();
      const code2 = await runCli(["scene", "import-svg", inputSvg, "--output", dest2, "--json"], dir, cap2.io);
      expect(code2).toBe(0);

      const content1 = await readFile(dest1, "utf8");
      const content2 = await readFile(dest2, "utf8");
      expect(content1).toBe(content2);
      expect(sha256(content1)).toBe(sha256(content2));

      // Both destinations compile to byte-identical SVG
      const parsed1 = JSON.parse(content1);
      const parsed2 = JSON.parse(content2);
      const compile1 = compileScene(parsed1);
      const compile2 = compileScene(parsed2);
      expect(compile1.ok).toBe(true);
      expect(compile2.ok).toBe(true);
      if (compile1.ok && compile2.ok) {
        expect(compile1.value.svg).toBe(compile2.value.svg);
      }
    });

    it("supports end-to-end import -> validate -> compile pipeline via CLI", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "start.svg");
      const importedJson = join(dir, "imported.json");
      const compiledSvg1 = join(dir, "compiled1.svg");
      const compiledSvg2 = join(dir, "compiled2.svg");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      // Step 1: Import SVG
      const capImport = capture();
      const codeImport = await runCli(
        ["scene", "import-svg", inputSvg, "--output", importedJson, "--json"],
        dir,
        capImport.io,
      );
      expect(codeImport).toBe(0);

      // Step 2: Validate imported scene
      const capVal = capture();
      const codeVal = await runCli(["scene", "validate", importedJson, "--json"], dir, capVal.io);
      expect(codeVal).toBe(0);
      const valEnvelope = JSON.parse(capVal.stdout());
      expect(valEnvelope.status).toBe("ok");
      expect(valEnvelope.data?.action).toBe("validate");

      // Step 3: Compile imported scene to destination 1
      const capComp1 = capture();
      const codeComp1 = await runCli(
        ["scene", "compile", importedJson, "--output", compiledSvg1, "--json"],
        dir,
        capComp1.io,
      );
      expect(codeComp1).toBe(0);

      // Step 4: Compile imported scene to destination 2
      const capComp2 = capture();
      const codeComp2 = await runCli(
        ["scene", "compile", importedJson, "--output", compiledSvg2, "--json"],
        dir,
        capComp2.io,
      );
      expect(codeComp2).toBe(0);

      // Verify compile determinism
      const svg1 = await readFile(compiledSvg1, "utf8");
      const svg2 = await readFile(compiledSvg2, "utf8");
      expect(svg1).toBe(svg2);
    });

    it("can be invoked directly via runSceneCli", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "direct.svg");
      const outputJson = join(dir, "direct.json");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      const cap = capture();
      const exitCode = await runSceneCli(
        ["import-svg", inputSvg, "--output", outputJson, "--json"],
        dir,
        cap.io,
      );
      expect(exitCode).toBe(0);

      const envelope = JSON.parse(cap.stdout());
      expect(envelope.status).toBe("ok");
      expect(envelope.data.action).toBe("import-svg");
      expect(envelope.data.classification).toBe("SUPPORTED_IMPORT");
    });
  });

  describe("denials and no partial publication", () => {
    it("denies unsafe script SVG and creates no output file", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "script.svg");
      const outputJson = join(dir, "output.json");
      await writeFile(inputSvg, unsafeScriptSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", outputJson, "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneImportSvgJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.exitCode).toBe(1);
      expect(envelope.data?.classification).toBe("REJECTED_UNSAFE");
      expect(envelope.data?.written).toBe(false);
      expect(envelope.diagnostics.length).toBeGreaterThan(0);

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("denies unsafe foreignObject SVG and creates no output file", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "foreign.svg");
      const outputJson = join(dir, "output.json");
      await writeFile(inputSvg, unsafeForeignObjectSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", outputJson, "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneImportSvgJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.data?.classification).toBe("REJECTED_UNSAFE");
      expect(envelope.data?.written).toBe(false);

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("denies external href SVG and creates no output file", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "external.svg");
      const outputJson = join(dir, "output.json");
      await writeFile(inputSvg, externalHrefSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", outputJson, "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneImportSvgJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.data?.written).toBe(false);

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("denies unsupported class attribute and creates no output file", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "class.svg");
      const outputJson = join(dir, "output.json");
      await writeFile(inputSvg, unsupportedClassSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", outputJson, "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneImportSvgJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.data?.classification).toBe("SUPPORTED_ANALYZE_ONLY");
      expect(envelope.data?.written).toBe(false);

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("denies unsupported text element and creates no output file", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "text.svg");
      const outputJson = join(dir, "output.json");
      await writeFile(inputSvg, unsupportedTextSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", outputJson, "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneImportSvgJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.data?.written).toBe(false);

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("denies non-UTF-8 input bytes and creates no output file", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "invalid-utf8.svg");
      const outputJson = join(dir, "output.json");
      await writeFile(inputSvg, Buffer.from([0xff, 0xfe, 0xfd, 0xfc]));

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", outputJson, "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneImportSvgJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.data?.classification).toBe("INVALID_INPUT");
      expect(envelope.data?.written).toBe(false);

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("rejects input SVG file exceeding 8 MiB limit", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "oversized.svg");
      const outputJson = join(dir, "output.json");
      const bigBuffer = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20);
      await writeFile(inputSvg, bigBuffer);

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", outputJson, "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout());
      expect(envelope.status).toBe("error");
      expect(envelope.diagnostics[0]?.code).toBe("SCENE_FILE_LIMIT_EXCEEDED");

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("reports rejection in human mode without creating output file", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "reject.svg");
      const outputJson = join(dir, "output.json");
      await writeFile(inputSvg, unsafeScriptSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(["scene", "import-svg", inputSvg, "--output", outputJson], dir, cap.io);

      expect(exitCode).toBe(1);
      expect(cap.stderr()).toContain("IMPORT_REJECTED: REJECTED_UNSAFE");
      expect(cap.stdout()).toBe("");

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe("filesystem and absent-only target semantics", () => {
    it("rejects when output target already exists and preserves original file", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      const outputJson = join(dir, "existing.json");
      await writeFile(inputSvg, validShapeSvg, "utf8");
      await writeFile(outputJson, "ORIGINAL_UNTOUCHED_CONTENT", "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", outputJson, "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.diagnostics[0]?.code).toBe("SCENE_PUBLISH_TARGET_EXISTS");

      const content = await readFile(outputJson, "utf8");
      expect(content).toBe("ORIGINAL_UNTOUCHED_CONTENT");
    });

    it("rejects when output target is a symlink", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      const realTarget = join(dir, "real-target.json");
      const symlinkDest = join(dir, "symlink-dest.json");
      await writeFile(inputSvg, validShapeSvg, "utf8");
      await symlink(realTarget, symlinkDest);

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", symlinkDest, "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.status).toBe("error");

      const exists = await access(realTarget).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("rejects when output parent component is a symlink", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      const realParent = join(dir, "real-parent");
      const linkParent = join(dir, "link-parent");
      await mkdir(realParent);
      await symlink(realParent, linkParent);
      await writeFile(inputSvg, validShapeSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", join(linkParent, "out.json"), "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.diagnostics[0]?.code).toBe("SCENE_PUBLISH_TARGET_INVALID");
    });

    it("rejects non-existent input SVG file", async () => {
      const dir = await makeTestDir();
      const nonExistent = join(dir, "missing.svg");
      const outputJson = join(dir, "out.json");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", nonExistent, "--output", outputJson, "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.diagnostics[0]?.code).toBe("SCENE_FILE_INVALID");

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("rejects when input SVG is a symlink", async () => {
      const dir = await makeTestDir();
      const realSvg = join(dir, "real.svg");
      const linkedSvg = join(dir, "linked.svg");
      const outputJson = join(dir, "out.json");
      await writeFile(realSvg, validShapeSvg, "utf8");
      await symlink(realSvg, linkedSvg);

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", linkedSvg, "--output", outputJson, "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.diagnostics[0]?.code).toBe("SCENE_FILE_INVALID");

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe("argument validation (--force, --dry-run, options)", () => {
    it("rejects --force flag", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      const outputJson = join(dir, "out.json");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", outputJson, "--force", "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout());
      expect(envelope.diagnostics[0]?.code).toBe("USAGE_ERROR");
      expect(envelope.diagnostics[0]?.message).toContain("--force is not supported by scene import-svg");

      const exists = await access(outputJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("rejects -f flag", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      const outputJson = join(dir, "out.json");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", outputJson, "-f"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      expect(cap.stderr()).toContain("--force is not supported by scene import-svg");
    });

    it("rejects --dry-run flag", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      const outputJson = join(dir, "out.json");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", outputJson, "--dry-run", "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout());
      expect(envelope.diagnostics[0]?.code).toBe("USAGE_ERROR");
      expect(envelope.diagnostics[0]?.message).toContain("--dry-run is not supported by scene import-svg");
    });

    it("rejects missing --output flag", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(["scene", "import-svg", inputSvg], dir, cap.io);

      expect(exitCode).toBe(1);
      expect(cap.stderr()).toContain("scene import-svg requires --output <absent-scene.json>");
    });

    it("rejects --output missing value", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(["scene", "import-svg", inputSvg, "--output"], dir, cap.io);

      expect(exitCode).toBe(1);
      expect(cap.stderr()).toContain("scene import-svg requires a valid output file path");
    });

    it("rejects repeated --output flag", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", "a.json", "--output", "b.json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      expect(cap.stderr()).toContain("--output cannot be repeated");
    });

    it("rejects repeated --json flag", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", inputSvg, "--output", "a.json", "--json", "--json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout());
      expect(envelope.diagnostics[0]?.message).toContain("--json cannot be repeated");
    });

    it("rejects missing input file positional", async () => {
      const dir = await makeTestDir();
      const cap = capture();
      const exitCode = await runCli(["scene", "import-svg", "--output", "a.json"], dir, cap.io);

      expect(exitCode).toBe(1);
      expect(cap.stderr()).toContain("scene import-svg requires exactly one input SVG file");
    });

    it("rejects multiple positional arguments", async () => {
      const dir = await makeTestDir();
      const input1 = join(dir, "1.svg");
      const input2 = join(dir, "2.svg");
      await writeFile(input1, validShapeSvg, "utf8");
      await writeFile(input2, validShapeSvg, "utf8");

      const cap = capture();
      const exitCode = await runCli(
        ["scene", "import-svg", input1, input2, "--output", "a.json"],
        dir,
        cap.io,
      );

      expect(exitCode).toBe(1);
      expect(cap.stderr()).toContain("scene import-svg requires exactly one input SVG file");
    });

    it("rejects unsupported flags like --root or --select", async () => {
      const dir = await makeTestDir();
      const inputSvg = join(dir, "input.svg");
      await writeFile(inputSvg, validShapeSvg, "utf8");

      for (const flag of ["--root", "--workspace", "--select", "--companion"]) {
        const cap = capture();
        const exitCode = await runCli(
          ["scene", "import-svg", inputSvg, "--output", "out.json", flag, "--json"],
          dir,
          cap.io,
        );
        expect(exitCode).toBe(1);
        const envelope = JSON.parse(cap.stdout());
        expect(envelope.diagnostics[0]?.code).toBe("USAGE_ERROR");
      }
    });
  });

  describe("extracted scene-files helpers", () => {
    it("readSceneFileBytes reads bounded snapshot bytes and preserves old diagnostics", async () => {
      const dir = await makeTestDir();
      const testFile = join(dir, "sample.svg");
      await writeFile(testFile, validShapeSvg, "utf8");

      const bytes = await readSceneFileBytes(testFile);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(bytes).toString("utf8")).toBe(validShapeSvg);
    });

    it("publishSceneJson publishes formatted scene JSON and absent-only target", async () => {
      const dir = await makeTestDir();
      const dest = join(dir, "published.json");
      const canonical = JSON.stringify({
        schema: "tfsb.vector-scene-v1",
        compatibility: 1,
        compilerLevel: 1,
        profile: "illustration",
        artboard: { width: 100, height: 100, viewBox: [0, 0, 100, 100] },
        accessibility: { mode: "decorative" },
        elements: [{ id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10 }],
      });

      const res = await publishSceneJson(dest, canonical);
      expect(res.published).toBe(true);
      expect(res.dryRun).toBe(false);

      const onDisk = await readFile(dest, "utf8");
      expect(onDisk).toBe(canonical);
      expect(JSON.parse(onDisk).schema).toBe("tfsb.vector-scene-v1");
    });

    it("publishes exactly 8 MiB of validated JSON and rejects one extra byte before parsing", async () => {
      const dir = await makeTestDir();
      const imported = sceneImportSvg(Buffer.from(validShapeSvg));
      expect(imported.classification).toBe("SUPPORTED_IMPORT");
      const json = imported.canonicalScene!;
      const exact = json + " ".repeat(8 * 1024 * 1024 - Buffer.byteLength(json));
      const accepted = join(dir, "exact.json");
      await expect(publishSceneJson(accepted, exact)).resolves.toMatchObject({ published: true });
      expect(Buffer.byteLength(await readFile(accepted, "utf8"))).toBe(8 * 1024 * 1024);
      const denied = join(dir, "over.json");
      await expect(publishSceneJson(denied, exact + " ")).rejects.toThrow(/8 MiB/);
      expect(await access(denied).then(() => true, () => false)).toBe(false);
    });

    it("publishSceneJson rejects invalid scene content before publication", async () => {
      const dir = await makeTestDir();
      const dest = join(dir, "invalid.json");
      const badJson = JSON.stringify({
        schema: "tfsb.vector-scene-v1",
        compatibility: 1,
        compilerLevel: 1,
        profile: "illustration",
        artboard: { width: -10, height: 100, viewBox: [0, 0, 100, 100] }, // invalid negative dimension
      });

      await expect(publishSceneJson(dest, badJson)).rejects.toThrow();
      const exists = await access(dest).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });
});
