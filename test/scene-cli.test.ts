import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { runSceneCli } from "../src/scene-cli.js";
import { resolvePreset } from "../src/scene/constants.js";
import type { JsonResultEnvelope, SceneJsonData, SceneValidateJsonData } from "../src/json.js";

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

it("enforces the exact UTF-8 byte cap on illustration compilations before publishing", async () => {
  const dir = await makeTestDir();
  const source = join(dir, "scene.json");
  const scene = {
    ...sampleValidScene,
    artboard: resolvePreset("hero"),
    accessibility: { mode: "labelled", title: `${"x".repeat(80)}é` },
    // Exponent notation keeps the JSON small while producing real SVG path data.
    elements: [
      ...Array.from({ length: 317 }, (_, i) => ({
        type: "path", id: `p${i}`, d: "M0 0" + "l1e-80 1e-80".repeat(300),
      })),
      { type: "path", id: "tail", d: "M0 0" + "l1e-80 1e-80".repeat(80) },
    ],
  };
  await writeFile(source, JSON.stringify(scene), "utf8");
  const accepted = capture();
  expect(await runSceneCli(
    ["compile", "scene.json", "--illustration-source", "--output", "exact.svg", "--json"], dir, accepted.io,
  )).toBe(0);
  expect((await readFile(join(dir, "exact.svg"))).byteLength).toBe(16_000_000);

  scene.accessibility.title += "x";
  await writeFile(source, JSON.stringify(scene), "utf8");
  for (const dryRun of [[], ["--dry-run"]]) {
    const rejected = capture();
    expect(await runSceneCli(
      ["compile", "scene.json", "--illustration-source", "--output", "over.svg", "--json", ...dryRun], dir, rejected.io,
    )).toBe(1);
    expect(JSON.parse(rejected.stdout())).toMatchObject({
      data: null, diagnostics: [{ code: "SCENE_ILLUSTRATION_SVG_LIMIT" }],
    });
    await expect(access(join(dir, "over.svg"))).rejects.toMatchObject({ code: "ENOENT" });
  }

  const generic = capture();
  expect(await runSceneCli(["compile", "scene.json", "--output", "generic.svg"], dir, generic.io)).toBe(0);
  expect((await readFile(join(dir, "generic.svg"))).byteLength).toBe(16_000_001);
});

it.each([
  ["compile", "--illustration-source", "--illustration-source"],
  ["compile", "--illustration-source=true"],
  ["validate", "--illustration-source"],
])("rejects invalid illustration-source arguments (%s %s)", async (action, ...flags) => {
  const cap = capture();
  expect(await runSceneCli([action, ...flags, "missing.json", "--json"], "/tmp", cap.io)).toBe(1);
  expect(JSON.parse(cap.stdout()).diagnostics[0].code).toBe("USAGE_ERROR");
});

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
  it("requires an exact reviewed SVG digest before exporting WebP", async () => {
    const dir = await makeTestDir();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><path d="M 0 0 L 4 4" /></svg>';
    await writeFile(join(dir, "source.svg"), svg);
    const args = ["export-webp", "source.svg", "--output", "output.webp", "--json"];
    for (const [extra, code] of [
      [[], "USAGE_ERROR"],
      [["--expect-svg-digest", "sha256:" + "0".repeat(64)], "SCENE_RASTER_SVG_DIGEST_MISMATCH"],
      [["--expect-svg-digest", "sha256:" + createHash("sha256").update(svg).digest("hex")], "SCENE_RASTER_SVG_REJECTED"],
    ] as const) {
      const run = capture();
      expect(await runSceneCli([...args, ...extra], dir, run.io)).toBe(1);
      expect(JSON.parse(run.stdout())).toMatchObject({ data: null, diagnostics: [{ code }] });
      await expect(access(join(dir, "output.webp"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  describe("path revisions", () => {
    const source = {
      ...sampleValidScene,
      elements: [{
        id: "face", type: "group", children: [
          { id: "mouth", type: "path", d: "M 4 5 L 9 5", presentation: { stroke: { type: "solid", color: "#4A90E2" } } },
          { id: "brow", type: "path", d: "M 7 3 L 9 3" },
        ],
      }, ...sampleValidScene.elements, {
        id: "ornament", type: "use", href: "#badge", width: 10, height: 10,
      }],
      definitions: {
        symbols: [{ type: "symbol", id: "badge", viewBox: [0, 0, 10, 10],
          elements: [{ id: "badge-detail", type: "path", d: "M 1 2 L 3 4" }] }],
      },
    };

    it("revises editable paths, preserves the source, and produces deterministic compilable JSON", async () => {
      const dir = await makeTestDir();
      const original = JSON.stringify(source);
      const edits = JSON.stringify([
        { id: "mouth", d: "M 4 5 Q 6 7 9 5" },
        { id: "badge-detail", d: "M 2 1 L 4 3" },
      ]);
      await writeFile(join(dir, "scene.json"), original);
      await writeFile(join(dir, "edits.json"), edits);
      const args = ["scene", "revise", "scene.json", "--edits", "edits.json", "--output", "revise.json", "--json"];
      const preview = capture();
      expect(await runCli([...args, "--dry-run"], dir, preview.io)).toBe(0);
      await expect(access(join(dir, "revise.json"))).rejects.toThrow();
      const actual = capture();
      expect(await runCli(args, dir, actual.io)).toBe(0);
      const revised = await readFile(join(dir, "revise.json"), "utf8");
      const digest = createHash("sha256").update(revised).digest("hex");
      expect(JSON.parse(preview.stdout()).data).toMatchObject({ action: "revise", written: false, dryRun: true, outputSha256: digest });
      expect(JSON.parse(actual.stdout()).data).toMatchObject({ action: "revise", written: true, dryRun: false, outputSha256: digest });
      expect(JSON.parse(revised)).toMatchObject({
        elements: [{ id: "face", children: [
          { id: "mouth", d: "M 4 5 Q 6 7 9 5", presentation: { stroke: { color: "#4A90E2" } } },
          { id: "brow", d: "M 7 3 L 9 3" },
        ] }, { id: "rect-1" }, { id: "ornament" }],
        definitions: { symbols: [{ elements: [{ id: "badge-detail", d: "M 2 1 L 4 3" }] }] },
      });
      expect(await readFile(join(dir, "scene.json"), "utf8")).toBe(original);
      expect(await runCli(args, dir, capture().io)).toBe(1);
      expect(await readFile(join(dir, "revise.json"), "utf8")).toBe(revised);
      expect(await runCli(["scene", "compile", "revise.json", "--output", "revise.svg"], dir, capture().io)).toBe(0);
      expect(await readFile(join(dir, "revise.svg"), "utf8")).toContain('d="M 4 5 Q 6 7 9 5"');
    });

    const appendGroup = {
      type: "group", id: "tablet",
      children: [{ type: "path", id: "tablet-screen", d: "M 2 3 H 7 V 8 H 2 Z" }],
    };

    it("appends a named foreground group whose paths can be revised", async () => {
      const dir = await makeTestDir();
      const original = JSON.stringify(source);
      await writeFile(join(dir, "scene.json"), original);
      await writeFile(join(dir, "append.json"), JSON.stringify({ appendGroup }));
      const args = ["scene", "revise", "scene.json", "--edits", "append.json", "--output", "added.json", "--json"];
      const preview = capture();
      expect(await runCli([...args, "--dry-run"], dir, preview.io)).toBe(0);
      await expect(access(join(dir, "added.json"))).rejects.toThrow();
      const actual = capture();
      expect(await runCli(args, dir, actual.io)).toBe(0);
      expect(JSON.parse(preview.stdout()).data.outputSha256).toBe(JSON.parse(actual.stdout()).data.outputSha256);
      const added = JSON.parse(await readFile(join(dir, "added.json"), "utf8"));
      expect(added.elements.map(({ id }: { id: string }) => id)).toEqual(["face", "rect-1", "ornament", "tablet"]);
      expect(added.elements.at(-1)).toEqual(appendGroup);
      expect(await readFile(join(dir, "scene.json"), "utf8")).toBe(original);
      await writeFile(join(dir, "replace.json"), JSON.stringify([{ id: "tablet-screen", d: "M 2 3 H 8 V 8 H 2 Z" }]));
      expect(await runCli(["scene", "revise", "added.json", "--edits", "replace.json", "--output", "revised.json"], dir, capture().io)).toBe(0);
      const revised = JSON.parse(await readFile(join(dir, "revised.json"), "utf8"));
      expect(revised.elements.at(-1).children[0].d).toBe("M 2 3 H 8 V 8 H 2 Z");
    });

    it.each([
      { appendGroup, paths: [] },
      { appendGroup: { ...appendGroup, id: "face" } },
      { appendGroup: { ...appendGroup, id: undefined } },
      { appendGroup: { ...appendGroup, children: [] } },
      { appendGroup: appendGroup.children[0] },
      { appendGroup: { ...appendGroup, children: [{ ...appendGroup.children[0], id: "mouth" }] } },
      { appendGroup: { ...appendGroup, children: [{ ...appendGroup.children[0], d: "M 1" }] } },
    ])("refuses an invalid group append without writing a scene %#", async (edits) => {
      const dir = await makeTestDir();
      await writeFile(join(dir, "scene.json"), JSON.stringify(source));
      await writeFile(join(dir, "edits.json"), JSON.stringify(edits));
      expect(await runCli(["scene", "revise", "scene.json", "--edits", "edits.json", "--output", "revised.json"], dir, capture().io)).toBe(1);
      await expect(access(join(dir, "revised.json"))).rejects.toThrow();
    });

    it.each([
      [{ id: "missing", d: "M 0 0 L 1 1" }],
      [{ id: "rect-1", d: "M 0 0 L 1 1" }],
      [{ id: "mouth", d: "M 0 0 L 1 1", fill: "red" }],
      [{ id: "mouth", d: "M 0 0 L 1 1" }, { id: "mouth", d: "M 1 1 L 2 2" }],
      [{ id: "mouth", d: "M 0 0 L" }],
    ].map((edits) => [edits] as const))("refuses invalid edits without creating a revision", async (edits) => {
      const dir = await makeTestDir();
      await writeFile(join(dir, "scene.json"), JSON.stringify(source));
      await writeFile(join(dir, "edits.json"), JSON.stringify(edits));
      const cap = capture();
      expect(await runCli(["scene", "revise", "scene.json", "--edits", "edits.json", "--output", "bad.json", "--json"], dir, cap.io)).toBe(1);
      await expect(access(join(dir, "bad.json"))).rejects.toThrow();
    });
  });

  describe("palette overrides", () => {
    const source = {
      ...sampleValidScene,
      tokenBindings: { "blue-base": "#4a90e2", "iris-color": "token:blue-base" },
      elements: [{
        ...sampleValidScene.elements[0],
        presentation: { fill: { type: "token", name: "iris-color" } },
      }],
    };

    it("recolors referenced and aliased tokens without editing the scene", async () => {
      const dir = await makeTestDir();
      const original = JSON.stringify(source);
      await writeFile(join(dir, "scene.json"), original);
      await writeFile(join(dir, "palette.json"), JSON.stringify({ "blue-base": "#135C60" }));
      const cap = capture();
      expect(await runCli([
        "scene", "compile", "scene.json", "--palette", "palette.json",
        "--output", "themed.svg",
      ], dir, cap.io)).toBe(0);
      expect(await readFile(join(dir, "themed.svg"), "utf8")).toContain('fill="#135C60"');
      expect(await readFile(join(dir, "scene.json"), "utf8")).toBe(original);
    });

    it.each(['{"iris-colour":"#135C60"}', '{"iris-color":"url(#other)"}', '{"iris-color":"#abc"}', "[]"])(
      "refuses an invalid palette and leaves the target absent (%s)",
      async (palette) => {
        const dir = await makeTestDir();
        await writeFile(join(dir, "scene.json"), JSON.stringify(source));
        await writeFile(join(dir, "palette.json"), palette);
        const cap = capture();
        expect(await runCli([
          "scene", "compile", "scene.json", "--palette", "palette.json",
          "--output", "refused.svg", "--json",
        ], dir, cap.io)).toBe(1);
        expect(cap.stdout()).toContain("SCENE_INVALID_PALETTE");
        await expect(access(join(dir, "refused.svg"))).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it.each([
      { ...source, tokenBindings: { ...source.tokenBindings, "blue-base": "token:missing" } },
      { ...source, tokenBindings: { ...source.tokenBindings, "blue-base": "token:iris-color" } },
      sampleInvalidScene,
    ])("preserves source errors even when a palette could replace a broken binding", async (invalidScene) => {
      const dir = await makeTestDir();
      await writeFile(join(dir, "scene.json"), JSON.stringify(invalidScene));
      await writeFile(join(dir, "palette.json"), '{"blue-base":"#135C60"}');
      const base = capture();
      const themed = capture();
      const compile = ["scene", "compile", "scene.json", "--output", "refused.svg", "--json"];
      expect(await runCli(compile, dir, base.io)).toBe(1);
      expect(await runCli([...compile, "--palette", "palette.json"], dir, themed.io)).toBe(1);
      expect(JSON.parse(themed.stdout()).diagnostics).toEqual(JSON.parse(base.stdout()).diagnostics);
      await expect(access(join(dir, "refused.svg"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("binds the effective palette to the dry-run receipt without writing output", async () => {
      const dir = await makeTestDir();
      await writeFile(join(dir, "scene.json"), JSON.stringify(source));
      await writeFile(join(dir, "palette.json"), '{"iris-color":"#135C60"}');
      const base = capture();
      const themed = capture();
      const compile = ["scene", "compile", "scene.json", "--output", "planned.svg", "--dry-run", "--json"];
      expect(await runCli(compile, dir, base.io)).toBe(0);
      expect(await runCli([...compile, "--palette", "palette.json"], dir, themed.io)).toBe(0);
      const { data } = JSON.parse(themed.stdout());
      const { receipt } = JSON.parse(base.stdout()).data;
      expect(data).toMatchObject({ dryRun: true, written: false });
      expect(data.receipt.tokenDigest).not.toBe(receipt.tokenDigest);
      expect(data.receipt.sourceDigest).not.toBe(receipt.sourceDigest);
      expect(data.receipt.svgDigest).not.toBe(receipt.svgDigest);
      await expect(access(join(dir, "planned.svg"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

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

      const envelope = JSON.parse(cap.stdout()) as JsonResultEnvelope<"scene", SceneValidateJsonData>;
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

  describe("rasterize", () => {
    it("refuses a compact render when the expected digest names the spaced SVG", async () => {
      const dir = await makeTestDir();
      const input = { ...sampleValidScene, elements: [{
        type: "path", d: "M 0 0 H 20 V 20 H 0 Z",
      }] };
      await writeFile(join(dir, "scene.json"), JSON.stringify(input));
      const compiled = capture();
      expect(await runSceneCli(["compile", "scene.json", "--output", "scene.svg", "--json"], dir, compiled.io)).toBe(0);
      const { svgDigest } = JSON.parse(compiled.stdout()).data.receipt;
      const cap = capture();
      expect(await runSceneCli([
        "rasterize", "scene.json", "--output", "scene.png", "--compact-paths",
        "--expect-svg-digest", svgDigest, "--json",
      ], dir, cap.io)).toBe(1);
      expect(JSON.parse(cap.stdout()).diagnostics[0].code).toBe("SCENE_RASTER_SVG_DIGEST_MISMATCH");
      await expect(access(join(dir, "scene.png"))).rejects.toThrow();
    });

    it.each([
      ["rasterize", "--expect-svg-digest"],
      ["rasterize", "--expect-svg-digest", "sha256:xyz"],
      ["rasterize", "--expect-svg-digest", "sha256:" + "a".repeat(64) + "\n"],
      ["rasterize", "--expect-svg-digest", "sha256:" + "A".repeat(64)],
      ["rasterize", "--expect-svg-digest", "sha256:" + "a".repeat(64), "--expect-svg-digest", "sha256:" + "b".repeat(64)],
      ["compile", "--expect-svg-digest", "sha256:" + "a".repeat(64)],
    ])("rejects invalid raster digest arguments %#", async (action, ...options) => {
      const dir = await makeTestDir();
      const cap = capture();
      expect(await runSceneCli([action, "absent.json", "--output", "absent.out", "--json", ...options], dir, cap.io)).toBe(1);
      expect(JSON.parse(cap.stdout()).diagnostics[0]).toMatchObject({
        code: "USAGE_ERROR", message: expect.stringContaining("--expect-svg-digest"),
      });
    });

    const directSource = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><title>Fixture</title><path d="M 0 0 H 8 V 8 Z" /></svg>';

    it("requires an expected digest for direct SVG rendering", async () => {
      const dir = await makeTestDir();
      const cap = capture();
      expect(await runSceneCli(["rasterize", "missing.svg", "--svg-source", "--output", "out.png", "--json"], dir, cap.io)).toBe(1);
      expect(JSON.parse(cap.stdout()).diagnostics[0].code).toBe("USAGE_ERROR");
    });

    it.each([
      ["rasterize", "--viewbox-size"],
      ["import-svg", "--svg-source", "--viewbox-size"],
      ["rasterize", "--svg-source", "--viewbox-size", "--viewbox-size"],
    ])("rejects invalid grid rasterization arguments %#", async (action, ...flags) => {
      const dir = await makeTestDir();
      const cap = capture();
      expect(await runSceneCli([
        action, "missing.svg", ...flags, "--output", "out.png", "--json",
      ], dir, cap.io)).toBe(1);
      expect(JSON.parse(cap.stdout()).diagnostics[0]).toMatchObject({
        code: "USAGE_ERROR", message: expect.stringContaining("--viewbox-size"),
      });
    });

    it("refuses a grid render that would change the reviewed framing", async () => {
      const dir = await makeTestDir();
      const input = { ...sampleValidScene, artboard: {
        width: 32, height: 16, viewBox: [0, 0, 16, 16],
      } };
      await writeFile(join(dir, "scene.json"), JSON.stringify(input));
      const compiled = capture();
      expect(await runSceneCli(["compile", "scene.json", "--output", "source.svg", "--json"], dir, compiled.io)).toBe(0);
      const { svgDigest } = JSON.parse(compiled.stdout()).data.receipt;
      const cap = capture();
      expect(await runSceneCli([
        "rasterize", "source.svg", "--svg-source", "--expect-svg-digest", svgDigest,
        "--viewbox-size", "--output", "out.png", "--json",
      ], dir, cap.io)).toBe(1);
      expect(JSON.parse(cap.stdout()).diagnostics[0].code).toBe("SCENE_RASTER_SIZE_INVALID");
      await expect(access(join(dir, "out.png"))).rejects.toThrow();
    });

    it.each([
      [directSource, "SCENE_RASTER_SVG_REJECTED"],
      [directSource.replace("</svg>", "<script/></svg>"), "SCENE_RASTER_SVG_REJECTED"],
      [directSource.replace('d="', 'onclick="noop" d="'), "SCENE_RASTER_SVG_REJECTED"],
      [directSource.replace("<path", '<use href="https://example.invalid/element"/><path'), "SCENE_RASTER_SVG_REJECTED"],
      [directSource.padEnd(16_000_000), "SCENE_RASTER_SVG_REJECTED"],
      [directSource.padEnd(16_000_001), "SCENE_FILE_LIMIT_EXCEEDED"],
    ])("refuses inadmissible direct SVG before publishing a PNG %#", async (input, code) => {
      const dir = await makeTestDir();
      await writeFile(join(dir, "source.svg"), input);
      const digest = "sha256:" + createHash("sha256").update(input).digest("hex");
      const cap = capture();
      expect(await runSceneCli([
        "rasterize", "source.svg", "--svg-source", "--expect-svg-digest", digest, "--output", "out.png", "--json",
      ], dir, cap.io)).toBe(1);
      expect(JSON.parse(cap.stdout()).diagnostics[0].code).toBe(code);
      await expect(access(join(dir, "out.png"))).rejects.toThrow();
    });

    it("rejects a changed direct SVG even when the replacement also compiles", async () => {
      const dir = await makeTestDir();
      await writeFile(join(dir, "scene.json"), JSON.stringify(sampleValidScene));
      expect(await runSceneCli(["compile", "scene.json", "--output", "source.svg"], dir, capture().io)).toBe(0);
      const cap = capture();
      expect(await runSceneCli([
        "rasterize", "source.svg", "--svg-source", "--expect-svg-digest", "sha256:" + "0".repeat(64),
        "--output", "out.png", "--json",
      ], dir, cap.io)).toBe(1);
      expect(JSON.parse(cap.stdout()).diagnostics[0].code).toBe("SCENE_RASTER_SVG_DIGEST_MISMATCH");
      await expect(access(join(dir, "out.png"))).rejects.toThrow();
    });

    it("requires an output and a whole-pixel artboard before loading the renderer", async () => {
      const dir = await makeTestDir();
      const input = { ...sampleValidScene, artboard: { ...sampleValidScene.artboard, width: 1440.5 } };
      await writeFile(join(dir, "scene.json"), JSON.stringify(input));
      const missing = capture();
      expect(await runSceneCli(["rasterize", "scene.json"], dir, missing.io)).toBe(1);
      expect(missing.stderr()).toContain("requires --output");
      const invalid = capture();
      expect(await runSceneCli(["rasterize", "scene.json", "--output", "scene.png", "--json"], dir, invalid.io)).toBe(1);
      expect(JSON.parse(invalid.stdout()).diagnostics[0].code).toBe("SCENE_RASTER_SIZE_INVALID");
      await expect(access(join(dir, "scene.png"))).rejects.toThrow();
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
      expect(cap.stdout()).toContain("tfsb scene compile <json> --output <absent.svg> [--palette <json>] [--compact-paths] [--illustration-source] [--dry-run] [--json]");
    });
  });
});
