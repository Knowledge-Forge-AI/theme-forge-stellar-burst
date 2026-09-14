import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FORGE_GRID_LABEL_V1_DIGEST,
  SCENE_COMPATIBILITY,
  SCENE_COMPILER_LEVEL,
  SCENE_SCHEMA,
  compileScene,
  inspectScene,
  validateScene,
} from "../src/scene/index.js";

const PROTOCOL_DIR = join(process.cwd(), "protocol/tfsb-scene-v1");
const EXAMPLES_DIR = join(PROTOCOL_DIR, "examples");

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function loadJson<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content) as T;
}

describe("tfsb-scene-v1 protocol contract", () => {
  const positiveFixtures = [
    "scene-illustration.json",
    "scene-diagram.json",
    "scene-editorial.json",
    "scene-promotional.json",
    "scene-pattern.json",
    "scene-geometry.json",
    "scene-paint.json",
    "scene-labels.json",
  ];

  describe("inventory integrity", () => {
    it("matches all example and schema hashes declared in inventory.json", async () => {
      const inventoryPath = join(PROTOCOL_DIR, "inventory.json");
      const inventory = await loadJson<{
        schema: string;
        schemaVersion: number;
        targetSchema: string;
        compatibility: number;
        compilerLevel: number;
        schemas: Array<{ name: string; sha256: string }>;
        examples: Array<{ name: string; sha256: string }>;
        denialsCorpus: { name: string; sha256: string };
        glyphCatalog: { digest: string };
      }>(inventoryPath);

      expect(inventory.schema).toBe("tfsb.vector-scene-inventory");
      expect(inventory.targetSchema).toBe(SCENE_SCHEMA);
      expect(inventory.compatibility).toBe(SCENE_COMPATIBILITY);
      expect(inventory.compilerLevel).toBe(SCENE_COMPILER_LEVEL);

      for (const s of inventory.schemas) {
        const fileBytes = await readFile(join(PROTOCOL_DIR, s.name));
        expect(sha256Hex(fileBytes), `Hash mismatch for schema ${s.name}`).toBe(s.sha256);
      }

      for (const ex of inventory.examples) {
        const fileBytes = await readFile(join(EXAMPLES_DIR, ex.name));
        expect(sha256Hex(fileBytes), `Hash mismatch for example ${ex.name}`).toBe(ex.sha256);
      }

      const denialsBytes = await readFile(join(EXAMPLES_DIR, inventory.denialsCorpus.name));
      expect(sha256Hex(denialsBytes), "Hash mismatch for denials corpus").toBe(inventory.denialsCorpus.sha256);

      expect(inventory.glyphCatalog.digest).toBe(FORGE_GRID_LABEL_V1_DIGEST);
    });
  });

  describe("positive scene fixtures", () => {
    it.each(positiveFixtures)(
      "validates, inspects, and compiles %s with byte-deterministic output",
      async (fileName) => {
        const filePath = join(EXAMPLES_DIR, fileName);
        const sceneData = await loadJson<unknown>(filePath);

        // 1. Validation pass
        const validation = validateScene(sceneData);
        expect(validation.ok, `validateScene failed on ${fileName}`).toBe(true);
        if (!validation.ok) return;

        const { scene, metrics } = validation.value;
        expect(scene.schema).toBe(SCENE_SCHEMA);
        expect(scene.compatibility).toBe(SCENE_COMPATIBILITY);
        expect(scene.compilerLevel).toBe(SCENE_COMPILER_LEVEL);
        expect(metrics.authoredElementCount).toBeGreaterThan(0);
        expect(metrics.expandedElementCount).toBeGreaterThanOrEqual(metrics.authoredElementCount);

        // 2. Inspection pass
        const inspection = inspectScene(sceneData);
        expect(inspection.ok, `inspectScene failed on ${fileName}`).toBe(true);
        if (!inspection.ok) return;

        expect(inspection.value.receipt.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(inspection.value.receipt.glyphCatalogDigest).toBe(FORGE_GRID_LABEL_V1_DIGEST);

        // 3. Compilation pass
        const compilation1 = compileScene(sceneData);
        expect(compilation1.ok, `compileScene failed on ${fileName}`).toBe(true);
        if (!compilation1.ok) return;

        const { svg: svg1, receipt: receipt1 } = compilation1.value;

        expect(svg1).toContain("<svg");
        expect(svg1.trim()).toMatch(/<\/svg>$/);
        expect(receipt1.svgDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

        // 4. Repeated compilation byte-determinism check
        const compilation2 = compileScene(sceneData);
        expect(compilation2.ok).toBe(true);
        if (!compilation2.ok) return;

        expect(compilation2.value.svg).toBe(svg1);
        expect(compilation2.value.receipt.svgDigest).toBe(receipt1.svgDigest);
        expect(compilation2.value.receipt.sourceDigest).toBe(receipt1.sourceDigest);

        // 5. Accessibility contract check
        if (scene.accessibility.mode === "labelled") {
          expect(svg1).toContain("<title");
          expect(svg1).toContain(scene.accessibility.title);
          expect(svg1).toContain("aria-labelledby=");
        } else {
          expect(svg1).toContain('aria-hidden="true"');
          expect(svg1).not.toContain("<title");
        }
      },
    );
  });

  describe("negative scene denials corpus", () => {
    it("rejects all cases in scene-denials.json without unhandled exceptions", async () => {
      const denialsPath = join(EXAMPLES_DIR, "scene-denials.json");
      const corpus = await loadJson<{
        cases: Array<{ id: string; reason: string; scene: unknown }>;
      }>(denialsPath);

      expect(corpus.cases.length).toBeGreaterThanOrEqual(20);

      for (const denial of corpus.cases) {
        const valResult = validateScene(denial.scene);
        const compResult = compileScene(denial.scene);

        expect(
          !valResult.ok || !compResult.ok,
          `Expected denial case '${denial.id}' to fail validation or compilation: ${denial.reason}`,
        ).toBe(true);

        expect(
          compResult.ok,
          `Expected denial case '${denial.id}' to fail compilation: ${denial.reason}`,
        ).toBe(false);

        if (!compResult.ok) {
          expect(compResult.diagnostics.length).toBeGreaterThan(0);
          expect(compResult.diagnostics[0]?.message.length).toBeGreaterThan(0);
        }
      }
    });

    it("strictly rejects nested unknown properties at all levels", async () => {
      const baseScene = await loadJson<Record<string, unknown>>(
        join(EXAMPLES_DIR, "scene-diagram.json"),
      );

      // Unknown key in artboard
      const badArtboard = {
        ...baseScene,
        artboard: {
          ...(baseScene["artboard"] as Record<string, unknown>),
          unknownKey: "rejected",
        },
      };
      expect(validateScene(badArtboard).ok).toBe(false);

      // Unknown key in element
      const badElement = {
        ...baseScene,
        elements: [
          {
            type: "rect",
            id: "rectTest",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            unknownProp: 42,
          },
        ],
      };
      expect(validateScene(badElement).ok).toBe(false);

      // Unknown key in presentation
      const badPresentation = {
        ...baseScene,
        elements: [
          {
            type: "rect",
            id: "rectPres",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            presentation: {
              fill: { type: "none" },
              unknownStyle: true,
            },
          },
        ],
      };
      expect(validateScene(badPresentation).ok).toBe(false);

      // Unknown key in paint
      const badPaint = {
        ...baseScene,
        elements: [
          {
            type: "rect",
            id: "rectPaint",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            presentation: {
              fill: { type: "solid", color: "#ffffff", extraPaint: "disallowed" },
            },
          },
        ],
      };
      expect(validateScene(badPaint).ok).toBe(false);

      // Unknown key in gradient definition
      const badGradient = {
        ...baseScene,
        definitions: {
          gradients: [
            {
              id: "badGrad",
              type: "linearGradient",
              x1: 0,
              y1: 0,
              x2: 1,
              y2: 1,
              unknownParam: "fail",
              stops: [
                { offset: 0, color: { type: "solid", color: "#000000" } },
                { offset: 1, color: { type: "solid", color: "#ffffff" } },
              ],
            },
          ],
        },
      };
      expect(validateScene(badGradient).ok).toBe(false);
    });

    it("rejects non-finite and exponential numbers in coordinates", () => {
      const base = {
        schema: SCENE_SCHEMA,
        compatibility: SCENE_COMPATIBILITY,
        compilerLevel: SCENE_COMPILER_LEVEL,
        profile: "diagram",
        artboard: { width: 100, height: 100, viewBox: [0, 0, 100, 100], policy: "contain" },
        accessibility: { mode: "decorative" },
        elements: [{ type: "rect", id: "box", x: 0, y: 0, width: 10, height: 10 }],
      };

      expect(validateScene({ ...base, artboard: { ...base.artboard, width: NaN } }).ok).toBe(false);
      expect(validateScene({ ...base, artboard: { ...base.artboard, width: Infinity } }).ok).toBe(false);
      expect(
        validateScene({
          ...base,
          elements: [{ type: "rect", id: "box", x: 0, y: 0, width: -Infinity, height: 10 }],
        }).ok,
      ).toBe(false);
    });
  });
});
