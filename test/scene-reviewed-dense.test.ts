import { it, expect } from "vitest";
import { compileScene, reopenCanonicalSceneSvg } from "../src/scene/index.js";
import { SCENE_LIMITS } from "../src/scene/constants.js";
import { validateCanonicalSceneSvg } from "../src/scene/import-svg.js";

it("reopens dense canonical SVG within the editable scene limit", () => {
  const scene = {
    schema: "tfsb.vector-scene-v1",
    compatibility: 1,
    compilerLevel: 1,
    profile: "illustration",
    artboard: { width: 1024, height: 1536, viewBox: [0, 0, 1024, 1536], policy: "contain" },
    accessibility: { mode: "decorative" },
    elements: [
      ...Array.from({ length: 190 }, (_, i) => ({
        id: `p${i}`,
        type: "path",
        d: "M0 0" + "l.123456789-.123456789".repeat(1900),
      })),
      { id: "arc", type: "path", d: "M 1 1 a 0.5 0.25 0 0 1 -0.75 0.125 Z" },
    ],
  };
  const original = compileScene(scene);
  expect(original.ok).toBe(true);
  if (!original.ok) return;
  const svg = Buffer.from(original.value.svg);
  expect(svg.length).toBeLessThanOrEqual(16_000_000);

  const restored = reopenCanonicalSceneSvg(svg);
  expect(restored.reasonCodes).toEqual([]);
  expect(restored.compiled?.receipt.svgDigest).toBe(original.value.receipt.svgDigest);
  expect(restored.compiled?.svg === original.value.svg).toBe(true);
  const reviewed = validateCanonicalSceneSvg(svg, false);
  expect(reviewed.reasonCodes).toEqual([]);
  const reviewedCompile = compileScene(reviewed.scene);
  expect(reviewedCompile.ok && reviewedCompile.value.svg === original.value.svg).toBe(true);
  const json = restored.compiled?.canonicalJson ?? "";
  expect(Buffer.byteLength(json)).toBeLessThanOrEqual(SCENE_LIMITS.maxInputBytes);
  const rebuilt = compileScene(JSON.parse(json), { fitInput: true });
  expect(rebuilt.ok && rebuilt.value.canonicalJson === json).toBe(true);
  expect(rebuilt.ok && rebuilt.value.svg === original.value.svg).toBe(true);
}, 60_000);
