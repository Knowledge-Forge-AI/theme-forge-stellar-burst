import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { runSceneCli } from "../src/scene-cli.js";
import type { JsonResultEnvelope, SceneJsonData } from "../src/json.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function makeTestDir(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "tfsb-scene-cli-")));
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

const sampleValidScene = {
  schema: "tfsb.vector-scene-v1",
  compatibility: 1,
  compilerLevel: 1,
  profile: "illustration",
  artboard: {
    width: 1440,
    height: 720,
    viewBox: [0, 0, 1440, 720],
  },
  accessibility: {
    mode: "decorative",
  },
  elements: [
    {
      id: "rect-1",
      type: "rect",
      x: 20,
      y: 30,
      width: 200,
      height: 100,
      presentation: {
        fill: {
          type: "solid",
          color: "#4A90E2",
        },
      },
    },
  ],
};

const sampleInvalidScene = {
  schema: "tfsb.vector-scene-v1",
  compatibility: 1,
  compilerLevel: 1,
  profile: "illustration",
  artboard: {
    width: 1440,
    height: 720,
    viewBox: [0, 0, 1440, 720],
  },
  accessibility: {
    mode: "decorative",
  },
  elements: [
    {
      id: "rect-1",
      type: "rect",
      x: 20,
      y: 30,
      width: -50, // invalid negative dimension
      height: 100,
    },
  ],
};

describe("tfsb scene CLI integration", () => {
  describe("validate", () => {
    it("validates a valid scene in human mode", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "validate", sceneFile], dir, cap.io);

      expect(exitCode).toBe(0);
      expect(cap.stdout()).toContain("valid scene illustration");
      expect(cap.stdout()).toContain("1 elements");
      expect(cap.stderr()).toBe("");
    });

    it("validates a valid scene in JSON mode", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "validate", sceneFile, "--json"], dir, cap.io);

      expect(exitCode).toBe(0);
      expect(cap.stderr()).toBe("");

      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.command).toBe("scene");
      expect(envelope.status).toBe("ok");
      expect(envelope.exitCode).toBe(0);
      expect(envelope.diagnostics).toEqual([]);
      expect(envelope.data).not.toBeNull();
      expect(envelope.data?.schema).toBe("tfsb.scene-result-v1");
      expect(envelope.data?.action).toBe("validate");
      expect(envelope.data?.valid).toBe(true);
      expect(envelope.data?.metrics).toBeDefined();
    });

    it("rejects an invalid scene in human mode", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "invalid.json");
      await writeFile(sceneFile, JSON.stringify(sampleInvalidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "validate", sceneFile], dir, cap.io);

      expect(exitCode).toBe(1);
      expect(cap.stderr()).toContain("SCENE_INVALID_NUMBER");
      expect(cap.stdout()).toBe("");
    });

    it("rejects an invalid scene in JSON mode", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "invalid.json");
      await writeFile(sceneFile, JSON.stringify(sampleInvalidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "validate", sceneFile, "--json"], dir, cap.io);

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.command).toBe("scene");
      expect(envelope.status).toBe("error");
      expect(envelope.exitCode).toBe(1);
      expect(envelope.data).toBeNull();
      expect(envelope.diagnostics.length).toBeGreaterThan(0);
      expect(envelope.diagnostics[0]?.code).toBe("SCENE_INVALID_NUMBER");
    });

    it("rejects --force and unrelated flags", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      for (const flag of ["--force", "-f", "--dry-run", "--output", "--root", "--workspace"]) {
        const cap = capture();
        const exitCode = await runCli(["scene", "validate", sceneFile, flag], dir, cap.io);
        expect(exitCode).toBe(1);
        expect(cap.stderr()).toContain("USAGE_ERROR");
      }
    });

    it("rejects missing or multiple positional arguments", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const noArgs = capture();
      expect(await runCli(["scene", "validate"], dir, noArgs.io)).toBe(1);
      expect(noArgs.stderr()).toContain("USAGE_ERROR");

      const twoArgs = capture();
      expect(await runCli(["scene", "validate", sceneFile, sceneFile], dir, twoArgs.io)).toBe(1);
      expect(twoArgs.stderr()).toContain("USAGE_ERROR");
    });

    it("rejects repeated --json flag", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "validate", sceneFile, "--json", "--json"], dir, cap.io);
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout());
      expect(envelope.status).toBe("error");
      expect(envelope.diagnostics[0]?.message).toContain("--json cannot be repeated");
    });
  });

  describe("inspect", () => {
    it("inspects a valid scene in human mode", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "inspect", sceneFile], dir, cap.io);

      expect(exitCode).toBe(0);
      expect(cap.stdout()).toContain("scene: illustration (tfsb.vector-scene-v1)");
      expect(cap.stdout()).toContain("source digest: sha256:");
      expect(cap.stdout()).toContain("svg digest: sha256:");
      expect(cap.stdout()).toContain("artboard: 1440x720");
      expect(cap.stderr()).toBe("");
    });

    it("inspects a valid scene in JSON mode", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "inspect", sceneFile, "--json"], dir, cap.io);

      expect(exitCode).toBe(0);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.command).toBe("scene");
      expect(envelope.status).toBe("ok");
      expect(envelope.data?.schema).toBe("tfsb.scene-result-v1");
      expect(envelope.data?.action).toBe("inspect");
      if (envelope.data?.action !== "inspect") throw new Error("Expected inspect result");
      expect(envelope.data?.valid).toBe(true);
      expect(envelope.data?.receipt).toBeDefined();
      expect(envelope.data?.metrics).toBeDefined();
    });

    it("rejects --force and unrelated flags for inspect", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      for (const flag of ["--force", "-f", "--dry-run", "--output", "--root"]) {
        const cap = capture();
        const exitCode = await runCli(["scene", "inspect", sceneFile, flag], dir, cap.io);
        expect(exitCode).toBe(1);
        expect(cap.stderr()).toContain("USAGE_ERROR");
      }
    });
  });

  describe("compile", () => {
    it("requires --output option", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "compile", sceneFile], dir, cap.io);
      expect(exitCode).toBe(1);
      expect(cap.stderr()).toContain("--output <absent.svg>");
    });

    it("compiles and publishes an SVG output file in human mode", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      const outputFile = join(dir, "output.svg");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "compile", sceneFile, "--output", outputFile], dir, cap.io);

      expect(exitCode).toBe(0);
      expect(cap.stdout()).toContain(`Compiled scene: ${outputFile}`);
      expect(cap.stdout()).toContain("svg digest: sha256:");
      expect(cap.stderr()).toBe("");

      const content = await readFile(outputFile, "utf8");
      expect(content).toContain("<svg");
      expect(content).toContain("<rect");
      expect(content).toContain("fill=\"#4A90E2\"");
    });

    it("compiles and publishes an SVG output file in JSON mode", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      const outputFile = join(dir, "output-json.svg");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "compile", sceneFile, "--output", outputFile, "--json"], dir, cap.io);

      expect(exitCode).toBe(0);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.command).toBe("scene");
      expect(envelope.status).toBe("ok");
      expect(envelope.data?.schema).toBe("tfsb.scene-result-v1");
      expect(envelope.data?.action).toBe("compile");
      if (envelope.data?.action !== "compile") throw new Error("Expected compile result");
      expect(envelope.data?.valid).toBe(true);
      expect(envelope.data?.output).toBe(outputFile);
      expect(envelope.data?.dryRun).toBe(false);
      expect(envelope.data?.written).toBe(true);
      expect(envelope.data?.receipt).toBeDefined();

      const exists = await access(outputFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it("supports --dry-run without writing output in human mode", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      const outputFile = join(dir, "output-dry.svg");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "compile", sceneFile, "--output", outputFile, "--dry-run"], dir, cap.io);

      expect(exitCode).toBe(0);
      expect(cap.stdout()).toContain("Compiled scene (dry-run):");
      expect(cap.stdout()).not.toContain("(0 B)");
      expect(cap.stdout()).toMatch(/Compiled scene \(dry-run\): .* \([1-9]\d* B\)/);
      expect(cap.stderr()).toBe("");

      const exists = await access(outputFile).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("supports --dry-run in JSON mode", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      const outputFile = join(dir, "output-dry-json.svg");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "compile", sceneFile, "--output", outputFile, "--dry-run", "--json"], dir, cap.io);

      expect(exitCode).toBe(0);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.status).toBe("ok");
      if (envelope.data?.action !== "compile") throw new Error("Expected compile result");
      expect(envelope.data?.dryRun).toBe(true);
      expect(envelope.data?.written).toBe(false);

      const exists = await access(outputFile).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("rejects pre-existing output file (absent-only publisher)", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      const outputFile = join(dir, "exists.svg");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));
      await writeFile(outputFile, "already here");

      const cap = capture();
      const exitCode = await runCli(["scene", "compile", sceneFile, "--output", outputFile, "--json"], dir, cap.io);

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.diagnostics[0]?.code).toBe("SCENE_PUBLISH_TARGET_EXISTS");
      expect(envelope.data).toBeNull();
    });

    it("rejects --force flag even when output exists", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      const outputFile = join(dir, "force.svg");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "compile", sceneFile, "--output", outputFile, "--force", "--json"], dir, cap.io);

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(cap.stdout());
      expect(envelope.diagnostics[0]?.code).toBe("USAGE_ERROR");
      expect(envelope.diagnostics[0]?.message).toContain("--force is not supported");
    });

    it("rejects unrelated legacy flags like --root, --workspace, --select", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      const outputFile = join(dir, "out.svg");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      for (const flag of ["--root", "--workspace", "--select", "--companion", "--manifest"]) {
        const cap = capture();
        const exitCode = await runCli(["scene", "compile", sceneFile, "--output", outputFile, flag, "--json"], dir, cap.io);
        expect(exitCode).toBe(1);
        const envelope = JSON.parse(cap.stdout());
        expect(envelope.diagnostics[0]?.code).toBe("USAGE_ERROR");
      }
    });

    it("rejects repeated flags (--output, --dry-run)", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const repOutput = capture();
      expect(await runCli(["scene", "compile", sceneFile, "--output", "a.svg", "--output", "b.svg"], dir, repOutput.io)).toBe(1);
      expect(repOutput.stderr()).toContain("--output cannot be repeated");

      const repDry = capture();
      expect(await runCli(["scene", "compile", sceneFile, "--output", "a.svg", "--dry-run", "--dry-run"], dir, repDry.io)).toBe(1);
      expect(repDry.stderr()).toContain("--dry-run cannot be repeated");
    });

    it("rejects --output missing value", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "compile", sceneFile, "--output"], dir, cap.io);
      expect(exitCode).toBe(1);
      expect(cap.stderr()).toContain("scene compile requires a valid output file path");
    });

    it("fails compilation of an invalid scene with JSON envelope", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "invalid.json");
      const outputFile = join(dir, "out.svg");
      await writeFile(sceneFile, JSON.stringify(sampleInvalidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "compile", sceneFile, "--output", outputFile, "--json"], dir, cap.io);
      expect(exitCode).toBe(1);

      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.exitCode).toBe(1);
      expect(envelope.data).toBeNull();
      expect(envelope.diagnostics.length).toBeGreaterThan(0);
      expect(envelope.diagnostics[0]?.code).toBe("SCENE_INVALID_NUMBER");

      const exists = await access(outputFile).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("rejects dryRun if target already exists", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      const outputFile = join(dir, "already.svg");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));
      await writeFile(outputFile, "already here");

      const cap = capture();
      const exitCode = await runCli(["scene", "compile", sceneFile, "--output", outputFile, "--dry-run", "--json"], dir, cap.io);
      expect(exitCode).toBe(1);

      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.diagnostics[0]?.code).toBe("SCENE_PUBLISH_TARGET_EXISTS");
    });

    it("redacts raw paths from diagnostics", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "bad-unknown.json");
      const sceneWithUnknown = {
        ...sampleValidScene,
        unauthorizedKey: "leak-test",
      };
      await writeFile(sceneFile, JSON.stringify(sceneWithUnknown, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "validate", sceneFile, "--json"], dir, cap.io);
      expect(exitCode).toBe(1);

      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneJsonData>;
      expect(envelope.status).toBe("error");
      expect(envelope.diagnostics[0]?.code).toBe("SCENE_UNKNOWN_PROPERTY");
      // Path redaction: message must not contain absolute dir path
      for (const diag of envelope.diagnostics) {
        expect(diag.message).not.toContain(dir);
      }
    });

    it("works with relative output paths", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runCli(["scene", "compile", "scene.json", "--output", "rel-out.svg"], dir, cap.io);
      expect(exitCode).toBe(0);

      const exists = await access(join(dir, "rel-out.svg")).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe("direct runSceneCli invocation", () => {
    it("can be invoked directly without runCli prefix", async () => {
      const dir = await makeTestDir();
      const sceneFile = join(dir, "scene.json");
      await writeFile(sceneFile, JSON.stringify(sampleValidScene, null, 2));

      const cap = capture();
      const exitCode = await runSceneCli(["validate", sceneFile, "--json"], dir, cap.io);
      expect(exitCode).toBe(0);

      const envelope = JSON.parse(cap.stdout());
      expect(envelope.status).toBe("ok");
      expect(envelope.data.action).toBe("validate");
    });
  });

  describe("general dispatch and help", () => {
    it("requires a subcommand when invoked as 'tfsb scene'", async () => {
      const cap = capture();
      expect(await runCli(["scene"], "/tmp", cap.io)).toBe(1);
      expect(cap.stderr()).toContain("scene requires validate, inspect, or compile");
    });

    it("rejects unknown scene action", async () => {
      const cap = capture();
      expect(await runCli(["scene", "destroy"], "/tmp", cap.io)).toBe(1);
      expect(cap.stderr()).toContain("Unknown scene action 'destroy'");
    });

    it("includes scene commands in tfsb --help", async () => {
      const cap = capture();
      expect(await runCli(["--help"], "/tmp", cap.io)).toBe(0);
      expect(cap.stdout()).toContain("tfsb scene validate <json> [--json]");
      expect(cap.stdout()).toContain("tfsb scene inspect <json> [--json]");
      expect(cap.stdout()).toContain("tfsb scene compile <json> --output <absent.svg> [--dry-run] [--json]");
    });
  });
});
