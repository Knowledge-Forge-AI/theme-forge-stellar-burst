import type { Artboard, CardinalAnchor, ScenePresetName, SceneProfile } from "./types.js";

export const SCENE_SCHEMA = "tfsb.vector-scene-v1" as const;
export const SCENE_COMPATIBILITY = 1 as const;
export const SCENE_COMPILER_LEVEL = 1 as const;

export const SCENE_PROFILES: readonly SceneProfile[] = [
  "illustration",
  "diagram",
  "editorial",
  "promotional",
  "pattern",
] as const;

export const SCENE_PRESETS: Readonly<Record<ScenePresetName, Artboard>> = {
  hero: {
    width: 1440,
    height: 720,
    viewBox: [0, 0, 1440, 720],
    policy: "contain",
  },
  section: {
    width: 960,
    height: 360,
    viewBox: [0, 0, 960, 360],
    policy: "contain",
  },
  diagram: {
    width: 1200,
    height: 675,
    viewBox: [0, 0, 1200, 675],
    policy: "contain",
  },
  figure: {
    width: 960,
    height: 540,
    viewBox: [0, 0, 960, 540],
    policy: "contain",
  },
  social: {
    width: 1200,
    height: 630,
    viewBox: [0, 0, 1200, 630],
    policy: "contain",
  },
} as const;

export const CARDINAL_ANCHORS: readonly CardinalAnchor[] = [
  "top",
  "bottom",
  "left",
  "right",
  "center",
] as const;

export function resolvePreset(name: ScenePresetName): Artboard {
  const preset = SCENE_PRESETS[name];
  if (preset === undefined) {
    throw new RangeError(`Unknown scene preset: '${name}'.`);
  }
  return {
    width: preset.width,
    height: preset.height,
    viewBox: [...preset.viewBox],
    ...(preset.policy !== undefined ? { policy: preset.policy } : {}),
  };
}

export const SCENE_LIMITS = Object.freeze({
  /** Maximum raw input bytes (8 MiB). */
  maxInputBytes: 8 * 1024 * 1024,
  /** Maximum expanded elements count after symbol resolution and layout lowering. */
  maxExpandedElements: 10_000,
  /** Maximum authored elements before expansion. */
  maxAuthoredElements: 2_000,
  /** Maximum tree nesting depth. */
  maxNestingDepth: 32,
  /** Maximum gradient stops per gradient definition. */
  maxGradientStops: 128,
  /** Maximum glyphs per label. */
  maxGlyphsPerLabel: 1_024,
  /** Maximum glyphs per scene. */
  maxGlyphsPerScene: 8_192,
  /** Maximum aggregate path segments across all paths and lowered labels. */
  maxAggregatePathSegments: 1_000_000,
  /** Maximum bytes per path data attribute to prevent quadratic scanning DoS. */
  maxPathBytes: 65_536,
  /** Maximum symbol definition count. */
  maxDefinitions: 500,
  /** Maximum token bindings count. */
  maxTokens: 1_000,
  /** Maximum layout directives count. */
  maxLayoutDirectives: 256,
  /** Maximum symbol instantiation reference depth. */
  maxSymbolDepth: 8,
  /** Maximum symbol amplification factor per symbol. */
  maxSymbolAmplification: 500,
  /** Maximum structural AST depth in raw input. */
  maxStructuralDepth: 128,
  /** Maximum AST nodes in raw input. */
  maxInputNodes: 100_000,
  maxOutputBytes: 33_554_432,
  maxCanonicalPathBytes: 1_048_576,
  maxCanonicalPathsBytes: 16_777_216,
  maxTransforms: 32,
  maxPoints: 10_000,
  maxLabelCharacters: 2_048,
} as const);

for (const preset of Object.values(SCENE_PRESETS)) { Object.freeze(preset.viewBox); Object.freeze(preset); }
Object.freeze(SCENE_PRESETS);
Object.freeze(SCENE_PROFILES);
Object.freeze(CARDINAL_ANCHORS);
