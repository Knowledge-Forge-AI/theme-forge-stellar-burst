import { describe, expect, it } from "vitest";
import { compileScene } from "../src/scene/index.js";
import { canonicalPathData } from "../src/scene/path-canonical.js";

const base = (elements: unknown[], layout: unknown[] = []) => ({ schema: "tfsb.vector-scene-v1", compatibility: 1, compilerLevel: 1, profile: "diagram", artboard: { width: 100, height: 100, viewBox: [0, 0, 100, 100], policy: "contain" }, elements, layout, accessibility: { mode: "labelled", title: "A & B" }, definitions: {}, tokenBindings: {}, provenance: {} });
const box = (id: string, x: number) => ({ type: "rect", id, x, y: 0, width: 10, height: 10 });
describe("scene lowering acceptance challenges", () => {
  it("spells validated arc flags and exponent operands without ambiguity", () => {
    expect(canonicalPathData("M-0 1e-7 A2 2 0 011 2")).toBe("M 0 0.0000001 A 2 2 0 0 1 1 2");
  });
  it("keeps node labels within the transformed opacity group and labels their geometry", () => {
    const result = compileScene(base([{ type: "diagramNode", id: "node", x: 0, y: 0, width: 40, height: 20, label: "A < B", transform: [{ type: "translate", x: 10 }], presentation: { opacity: 0.5 } }]));
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.svg).toMatch(/<g id="node" opacity="0.5" transform="[^"]+">\n\s*<rect/);
    expect(result.value.svg).toContain('aria-label="A &lt; B"');
    expect(result.value.svg).not.toContain("<desc");
    expect(result.value.svg).not.toMatch(/<(?:text|tspan)\b/);
  });
  it("allocates accessibility IDs around authored collisions", () => {
    const scene = base([box("scene-title", 0), box("scene-desc", 20)]);
    const result = compileScene({ ...scene, accessibility: { ...scene.accessibility, desc: "Authored description" } });
    expect(result.ok).toBe(true); if (!result.ok) return;
    const ids = [...result.value.svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.value.svg).toContain('aria-labelledby="scene-title-1 scene-desc-1"');
  });
  it("rejects contradictory axis writes and non-orthogonal waypoints", () => {
    expect(compileScene(base([box("a", 0), box("b", 20)], [{ type: "align", alignment: "left", targets: ["a", "b"] }, { type: "align", alignment: "right", targets: ["a", "b"] }])).ok).toBe(false);
    expect(compileScene(base([{ type: "connector", id: "edge", routing: "orthogonal", from: { x: 0, y: 0 }, to: { x: 20, y: 20 }, waypoints: [] }])).ok).toBe(false);
  });
});
