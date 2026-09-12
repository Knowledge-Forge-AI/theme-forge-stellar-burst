import { describe, expect, it } from "vitest";
import { compileScene, validateScene } from "../src/scene/index.js";
import { formatCanonicalNumber } from "../src/scene/canonical.js";

const rect = { type: "rect", id: "box", x: 0, y: 0, width: 10, height: 10 };
const scene = () => ({ schema: "tfsb.vector-scene-v1", compatibility: 1, compilerLevel: 1,
  profile: "diagram", artboard: { width: 100, height: 100, viewBox: [0, 0, 100, 100], policy: "contain" },
  accessibility: { mode: "labelled", title: "Hardening" }, elements: [rect], definitions: {}, tokenBindings: {}, provenance: {} });

describe("scene production boundary challenges", () => {
  it.each([Number.MIN_VALUE, 1e-7, 1e21, Number.MAX_VALUE, -0, 0.1 + 0.2])("preserves finite binary64 value %s", (value) => {
    const spelling = formatCanonicalNumber(value);
    expect(spelling).not.toMatch(/[eE]/);
    expect(Number(spelling)).toBe(Object.is(value, -0) ? 0 : value);
  });
  it("rejects unknown provenance and layout keys without silent loss", () => {
    expect(validateScene({ ...scene(), provenance: { script: "bad" } }).ok).toBe(false);
    expect(validateScene({ ...scene(), layout: [{ type: "align", alignment: "left", targets: ["box"], script: "bad" }] }).ok).toBe(false);
  });
  it("rejects private paths in typed provenance", () => {
    expect(validateScene({ ...scene(), provenance: { author: "/home/private/name" } }).ok).toBe(false);
  });
  it("rejects radial focal points outside the radius", () => {
    expect(validateScene({ ...scene(), definitions: { gradients: [{ type: "radialGradient", id: "radial", cx: 0, cy: 0, r: 1, fx: 2, fy: 0, stops: [{ offset: 0, color: { type: "solid", color: "#000000" } }, { offset: 1, color: { type: "solid", color: "#FFFFFF" } }] }] } }).ok).toBe(false);
  });
  it("rejects missing paint tokens even in unused symbols", () => {
    const painted = { ...rect, id: "inside", presentation: { fill: { type: "token", name: "absent" } } };
    expect(validateScene({ ...scene(), definitions: { symbols: [{ type: "symbol", id: "unused", viewBox: [0, 0, 10, 10], elements: [painted] }] } }).ok).toBe(false);
  });
  it("rejects missing layout and connector references during validation", () => {
    expect(validateScene({ ...scene(), layout: [{ type: "anchor", target: "box", targetAnchor: "center", relativeTo: "missing", relativeToAnchor: "center" }] }).ok).toBe(false);
    expect(validateScene({ ...scene(), elements: [{ type: "connector", id: "edge", routing: "straight", from: { elementId: "missing", anchor: "right" }, to: { x: 20, y: 20 } }] }).ok).toBe(false);
  });
  it("counts repeated symbol labels toward scene glyph ceiling before lowering", () => {
    expect(validateScene({ ...scene(), definitions: { symbols: [{ type: "symbol", id: "word", viewBox: [0, 0, 100, 10], elements: [{ type: "label", id: "label", text: "A".repeat(1024), x: 0, y: 0 }] }] }, elements: Array.from({ length: 9 }, (_, n) => ({ type: "use", id: `instance${n}`, href: "#word", width: 100, height: 10 })) }).ok).toBe(false);
  });
  it("returns a diagnostic for non-finite intermediate transforms", () => {
    expect(compileScene({ ...scene(), elements: [{ ...rect, transform: [{ type: "scale", x: 1e308 }, { type: "scale", x: 1e308 }] }] }).ok).toBe(false);
  });
  it("does not throw on cyclic direct API object input", () => {
    const cyclic: Record<string, unknown> = scene(); cyclic.provenance = cyclic;
    expect(validateScene(cyclic).ok).toBe(false);
  });
});
