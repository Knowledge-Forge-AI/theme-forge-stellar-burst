import {
  DiagnosticError,
  fail,
  type DiagnosticContext,
} from "../diagnostics.js";
import { canonicalPathData } from "./path-canonical.js";
import { isLocalId, LOCAL_ID_PATTERN, parseHexColor, parsePathData } from "../primitives.js";
import type { HexColor } from "../types.js";
import type { Result } from "./types.js";
import {
  FORGE_GRID_CELL_WIDTH,
  getGlyph,
} from "./glyphs/catalog.js";
import {
  countLabelGlyphs,
  validateLabelText,
} from "./glyphs/labels.js";
import {
  CARDINAL_ANCHORS,
  SCENE_COMPATIBILITY,
  SCENE_COMPILER_LEVEL,
  SCENE_LIMITS,
  SCENE_PROFILES,
  SCENE_SCHEMA,
} from "./constants.js";
import {
  validateTransformOperations,
} from "./transforms.js";
import { guardSceneInput } from "./guard.js";
import { computeElementBounds } from "./geometry.js";
import { lowerLayout } from "./layout.js";
import type {
  ArrowheadType,
  Artboard,
  BaseElement,
  CardinalAnchor,
  ConnectorElement,
  ConnectorEndpoint,
  DiagramNodeElement,
  GradientDef,
  GradientStop,
  LabelElement,
  LayoutDirective,
  LinearGradientDef,
  Paint,
  PathElement,
  Presentation,
  RadialGradientDef,
  SceneAccessibility,
  SceneDefinitions,
  SceneElement,
  SceneMetrics,
  SceneProfile,
  SceneProvenance,
  SymbolDef,
  TransformOperation,
  UseElement,
  VectorScene,
} from "./types.js";

const ARROWHEAD_TYPES = new Set<ArrowheadType>(["none", "triangle", "chevron"]);
const ANCHOR_NAMES = new Set<CardinalAnchor>(["top", "bottom", "left", "right", "center"]);

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  ctx: DiagnosticContext,
  location: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      fail(
        ctx,
        "SCENE_UNKNOWN_PROPERTY",
        `Unknown property '${key}' at ${location}.`,
        `${location}.${key}`,
      );
    }
  }
}

/**
 * Conservative path segment counter according to SVG command arities.
 */
export function countPathSegments(d: string): number {
  const normalized = canonicalPathData(d);
  if (normalized === "") return 0;

  const arity: Record<string, number> = {
    A: 7, C: 6, H: 1, L: 2, M: 2, Q: 4, S: 4, T: 2, V: 1, Z: 0,
  };

  const numberPattern = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g;
  const cmdPattern = /[AaCcHhLlMmQqSsTtVvZz]/g;

  let totalSegments = 0;
  let match: RegExpExecArray | null;
  const commands: { cmd: string; index: number }[] = [];

  while ((match = cmdPattern.exec(normalized)) !== null) {
    commands.push({ cmd: match[0].toUpperCase(), index: match.index });
  }

  for (let i = 0; i < commands.length; i += 1) {
    const { cmd, index } = commands[i]!;
    const nextIndex = i + 1 < commands.length ? commands[i + 1]!.index : normalized.length;
    const argSlice = normalized.slice(index + 1, nextIndex);
    const expected = arity[cmd] ?? 0;
    if (expected === 0) {
      totalSegments += 1;
    } else {
      const numbers = argSlice.match(numberPattern);
      const numCount = numbers ? numbers.length : 0;
      const count = Math.max(1, Math.floor(numCount / expected));
      totalSegments += count;
    }
  }

  return Math.max(1, totalSegments);
}

// Precomputed table of catalog path command counts per ASCII glyph
const GLYPH_COMMAND_COUNTS = new Array<number>(128).fill(0);
for (let code = 32; code <= 126; code += 1) {
  const g = getGlyph(String.fromCharCode(code));
  if (g && g.d !== "") {
    GLYPH_COMMAND_COUNTS[code] = countPathSegments(g.d);
  }
}

/**
 * Count exact path segments for label text using the first-party Forge Grid catalog.
 */
export function countTextPathSegments(text: string): number {
  let segs = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 32 && code <= 126) {
      segs += GLYPH_COMMAND_COUNTS[code]!;
    }
  }
  return segs;
}

export function validatePaint(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
  tokenBindings?: Readonly<Record<string, HexColor>>,
  definedGradients?: ReadonlySet<string>,
): Paint {
  if (typeof value !== "object" || value === null) {
    fail(ctx, "SCENE_INVALID_PAINT", "Paint must be an object.", location);
  }
  const obj = value as Record<string, unknown>;
  const type = obj["type"];

  switch (type) {
    case "none": {
      assertAllowedKeys(obj, ["type"], ctx, location);
      return { type: "none" };
    }
    case "currentColor": {
      assertAllowedKeys(obj, ["type"], ctx, location);
      return { type: "currentColor" };
    }
    case "solid": {
      assertAllowedKeys(obj, ["type", "color"], ctx, location);
      const color = parseHexColor(obj["color"], ctx, `${location}.color`);
      return { type: "solid", color };
    }
    case "token": {
      assertAllowedKeys(obj, ["type", "name"], ctx, location);
      const name = obj["name"];
      if (typeof name !== "string" || !LOCAL_ID_PATTERN.test(name)) {
        fail(ctx, "SCENE_INVALID_TOKEN", `Invalid token name '${String(name)}'.`, `${location}.name`);
      }
      if (tokenBindings === undefined || !Object.hasOwn(tokenBindings, name) || tokenBindings[name] === undefined) {
        fail(
          ctx,
          "SCENE_UNRESOLVED_TOKEN",
          `Paint token '${name}' could not be resolved from tokenBindings.`,
          location,
        );
      }
      return { type: "token", name };
    }
    case "gradient": {
      assertAllowedKeys(obj, ["type", "id", "fallback"], ctx, location);
      const id = obj["id"];
      if (typeof id !== "string" || !isLocalId(id)) {
        fail(ctx, "SCENE_INVALID_ID", "Gradient id must be a valid local id.", `${location}.id`);
      }
      if (definedGradients !== undefined && !definedGradients.has(id)) {
        fail(
          ctx,
          "SCENE_UNRESOLVED_TOKEN",
          `Gradient '${id}' could not be resolved from definitions.gradients.`,
          location,
        );
      }
      const fallback =
        obj["fallback"] !== undefined
          ? parseHexColor(obj["fallback"], ctx, `${location}.fallback`)
          : undefined;
      return {
        type: "gradient",
        id,
        ...(fallback !== undefined ? { fallback } : {}),
      };
    }
    default: {
      fail(
        ctx,
        "SCENE_INVALID_PAINT",
        `Unsupported paint type '${String(type)}'. Expected none, currentColor, solid, token, or gradient.`,
        `${location}.type`,
      );
    }
  }
}

export function validatePresentation(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
  tokenBindings?: Readonly<Record<string, HexColor>>,
  definedGradients?: ReadonlySet<string>,
): Presentation | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    fail(ctx, "SCENE_INVALID_PRESENTATION", "Presentation must be an object.", location);
  }
  const obj = value as Record<string, unknown>;
  assertAllowedKeys(
    obj,
    [
      "fill",
      "stroke",
      "strokeWidth",
      "strokeDasharray",
      "strokeDashoffset",
      "strokeLinecap",
      "strokeLinejoin",
      "strokeMiterlimit",
      "opacity",
      "fillOpacity",
      "strokeOpacity",
      "fillRule",
      "clipRule",
      "ariaHidden",
    ],
    ctx,
    location,
  );

  const result: Presentation = {
    ...(obj["fill"] !== undefined
      ? { fill: validatePaint(obj["fill"], ctx, `${location}.fill`, tokenBindings, definedGradients) }
      : {}),
    ...(obj["stroke"] !== undefined
      ? { stroke: validatePaint(obj["stroke"], ctx, `${location}.stroke`, tokenBindings, definedGradients) }
      : {}),
  };

  if (obj["strokeWidth"] !== undefined) {
    const sw = obj["strokeWidth"];
    if (typeof sw !== "number" || !Number.isFinite(sw) || sw < 0) {
      fail(ctx, "SCENE_INVALID_NUMBER", "strokeWidth must be a non-negative finite number.", `${location}.strokeWidth`);
    }
    Object.assign(result, { strokeWidth: sw });
  }

  if (obj["strokeDasharray"] !== undefined) {
    const da = obj["strokeDasharray"];
    if (!Array.isArray(da) || da.length > 32) {
      fail(ctx, "SCENE_INVALID_ARRAY", "strokeDasharray must be an array of at most 32 numbers.", `${location}.strokeDasharray`);
    }
    for (let i = 0; i < da.length; i += 1) {
      const v = da[i];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        fail(ctx, "SCENE_INVALID_NUMBER", "strokeDasharray elements must be non-negative numbers.", `${location}.strokeDasharray[${i}]`);
      }
    }
    Object.assign(result, { strokeDasharray: [...da] });
  }

  if (obj["strokeDashoffset"] !== undefined) {
    const sdo = obj["strokeDashoffset"];
    if (typeof sdo !== "number" || !Number.isFinite(sdo)) {
      fail(ctx, "SCENE_INVALID_NUMBER", "strokeDashoffset must be a finite number.", `${location}.strokeDashoffset`);
    }
    Object.assign(result, { strokeDashoffset: sdo });
  }

  if (obj["strokeLinecap"] !== undefined) {
    const cap = obj["strokeLinecap"];
    if (cap !== "butt" && cap !== "round" && cap !== "square") {
      fail(ctx, "SCENE_INVALID_ENUM", "strokeLinecap must be butt, round, or square.", `${location}.strokeLinecap`);
    }
    Object.assign(result, { strokeLinecap: cap });
  }

  if (obj["strokeLinejoin"] !== undefined) {
    const join = obj["strokeLinejoin"];
    if (join !== "miter" && join !== "round" && join !== "bevel") {
      fail(ctx, "SCENE_INVALID_ENUM", "strokeLinejoin must be miter, round, or bevel.", `${location}.strokeLinejoin`);
    }
    Object.assign(result, { strokeLinejoin: join });
  }

  if (obj["strokeMiterlimit"] !== undefined) {
    const ml = obj["strokeMiterlimit"];
    if (typeof ml !== "number" || !Number.isFinite(ml) || ml < 1) {
      fail(ctx, "SCENE_INVALID_NUMBER", "strokeMiterlimit must be a finite number >= 1.", `${location}.strokeMiterlimit`);
    }
    Object.assign(result, { strokeMiterlimit: ml });
  }

  for (const opKey of ["opacity", "fillOpacity", "strokeOpacity"] as const) {
    if (obj[opKey] !== undefined) {
      const v = obj[opKey];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        fail(ctx, "SCENE_INVALID_NUMBER", `${opKey} must be a number in [0, 1].`, `${location}.${opKey}`);
      }
      Object.assign(result, { [opKey]: v });
    }
  }

  for (const ruleKey of ["fillRule", "clipRule"] as const) {
    if (obj[ruleKey] !== undefined) {
      const r = obj[ruleKey];
      if (r !== "nonzero" && r !== "evenodd") {
        fail(ctx, "SCENE_INVALID_ENUM", `${ruleKey} must be nonzero or evenodd.`, `${location}.${ruleKey}`);
      }
      Object.assign(result, { [ruleKey]: r });
    }
  }

  if (obj["ariaHidden"] !== undefined) {
    if (typeof obj["ariaHidden"] !== "boolean") {
      fail(ctx, "SCENE_INVALID_BOOLEAN", "ariaHidden must be a boolean.", `${location}.ariaHidden`);
    }
    Object.assign(result, { ariaHidden: obj["ariaHidden"] });
  }

  return result;
}

export function validateGradientStop(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
  tokenBindings?: Readonly<Record<string, HexColor>>,
  definedGradients?: ReadonlySet<string>,
): GradientStop {
  if (typeof value !== "object" || value === null) {
    fail(ctx, "SCENE_INVALID_STOP", "Gradient stop must be an object.", location);
  }
  const obj = value as Record<string, unknown>;
  assertAllowedKeys(obj, ["offset", "color", "opacity"], ctx, location);

  const offset = obj["offset"];
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0 || offset > 1) {
    fail(ctx, "SCENE_INVALID_NUMBER", "Gradient stop offset must be in [0, 1].", `${location}.offset`);
  }

  const color = validatePaint(obj["color"], ctx, `${location}.color`, tokenBindings, definedGradients);
  if (color.type === "gradient" || color.type === "none") {
    fail(ctx, "SCENE_INVALID_PAINT", "Gradient stop cannot reference another gradient.", `${location}.color`);
  }

  let opacity: number | undefined;
  if (obj["opacity"] !== undefined) {
    const op = obj["opacity"];
    if (typeof op !== "number" || !Number.isFinite(op) || op < 0 || op > 1) {
      fail(ctx, "SCENE_INVALID_NUMBER", "Gradient stop opacity must be in [0, 1].", `${location}.opacity`);
    }
    opacity = op;
  }

  return {
    offset,
    color,
    ...(opacity !== undefined ? { opacity } : {}),
  };
}

export function validateLinearGradient(
  obj: Record<string, unknown>,
  ctx: DiagnosticContext,
  location: string,
  tokenBindings?: Readonly<Record<string, HexColor>>,
  definedGradients?: ReadonlySet<string>,
): LinearGradientDef {
  assertAllowedKeys(
    obj,
    ["id", "type", "x1", "y1", "x2", "y2", "gradientUnits", "spreadMethod", "stops"],
    ctx,
    location,
  );

  const id = obj["id"];
  if (typeof id !== "string" || !isLocalId(id)) {
    fail(ctx, "SCENE_INVALID_ID", "Gradient id must be a valid local id.", `${location}.id`);
  }

  for (const coord of ["x1", "y1", "x2", "y2"] as const) {
    const val = obj[coord];
    if (typeof val !== "number" || !Number.isFinite(val)) {
      fail(ctx, "SCENE_INVALID_NUMBER", `${coord} must be a finite number.`, `${location}.${coord}`);
    }
  }

  let gradientUnits: "userSpaceOnUse" | "objectBoundingBox" | undefined;
  if (obj["gradientUnits"] !== undefined) {
    const gu = obj["gradientUnits"];
    if (gu !== "userSpaceOnUse" && gu !== "objectBoundingBox") {
      fail(ctx, "SCENE_INVALID_ENUM", "gradientUnits must be userSpaceOnUse or objectBoundingBox.", `${location}.gradientUnits`);
    }
    gradientUnits = gu;
  }

  if (obj["spreadMethod"] !== undefined && obj["spreadMethod"] !== "pad") {
    fail(ctx, "SCENE_UNSUPPORTED_SPREAD", "Only pad spreadMethod is supported in Tier 1.", `${location}.spreadMethod`);
  }

  const rawStops = obj["stops"];
  if (!Array.isArray(rawStops) || rawStops.length < 2) {
    fail(ctx, "SCENE_INVALID_STOPS", "Gradient requires at least 2 stops.", `${location}.stops`);
  }
  if (rawStops.length > SCENE_LIMITS.maxGradientStops) {
    fail(
      ctx,
      "SCENE_LIMIT_EXCEEDED",
      `Gradient stop count ${rawStops.length} exceeds maximum allowed (${SCENE_LIMITS.maxGradientStops}).`,
      `${location}.stops`,
    );
  }

  const stops: GradientStop[] = [];
  let prevOffset = -1;
  for (let i = 0; i < rawStops.length; i += 1) {
    const stop = validateGradientStop(rawStops[i], ctx, `${location}.stops[${i}]`, tokenBindings, definedGradients);
    if (stop.offset < prevOffset) {
      fail(ctx, "SCENE_INVALID_STOPS", "Gradient stop offsets must be monotonically non-decreasing.", `${location}.stops[${i}]`);
    }
    prevOffset = stop.offset;
    stops.push(stop);
  }

  return {
    id,
    type: "linearGradient",
    x1: obj["x1"] as number,
    y1: obj["y1"] as number,
    x2: obj["x2"] as number,
    y2: obj["y2"] as number,
    ...(gradientUnits !== undefined ? { gradientUnits } : {}),
    ...(obj["spreadMethod"] !== undefined ? { spreadMethod: "pad" } : {}),
    stops,
  };
}

export function validateRadialGradient(
  obj: Record<string, unknown>,
  ctx: DiagnosticContext,
  location: string,
  tokenBindings?: Readonly<Record<string, HexColor>>,
  definedGradients?: ReadonlySet<string>,
): RadialGradientDef {
  assertAllowedKeys(
    obj,
    ["id", "type", "cx", "cy", "r", "fx", "fy", "gradientUnits", "spreadMethod", "stops"],
    ctx,
    location,
  );

  const id = obj["id"];
  if (typeof id !== "string" || !isLocalId(id)) {
    fail(ctx, "SCENE_INVALID_ID", "Gradient id must be a valid local id.", `${location}.id`);
  }

  for (const coord of ["cx", "cy"] as const) {
    const val = obj[coord];
    if (typeof val !== "number" || !Number.isFinite(val)) {
      fail(ctx, "SCENE_INVALID_NUMBER", `${coord} must be a finite number.`, `${location}.${coord}`);
    }
  }

  const r = obj["r"];
  if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) {
    fail(ctx, "SCENE_INVALID_GRADIENT", "Radial gradient radius r must be strictly positive.", `${location}.r`);
  }

  let fx: number | undefined;
  let fy: number | undefined;
  if (obj["fx"] !== undefined) {
    if (typeof obj["fx"] !== "number" || !Number.isFinite(obj["fx"])) {
      fail(ctx, "SCENE_INVALID_NUMBER", "fx must be a finite number.", `${location}.fx`);
    }
    fx = obj["fx"] as number;
  }
  if (obj["fy"] !== undefined) {
    if (typeof obj["fy"] !== "number" || !Number.isFinite(obj["fy"])) {
      fail(ctx, "SCENE_INVALID_NUMBER", "fy must be a finite number.", `${location}.fy`);
    }
    fy = obj["fy"] as number;
  }

  const focalX = fx ?? (obj["cx"] as number);
  const focalY = fy ?? (obj["cy"] as number);
  const focalDx = (focalX - (obj["cx"] as number)) / r;
  const focalDy = (focalY - (obj["cy"] as number)) / r;
  const squaredDistance = focalDx * focalDx + focalDy * focalDy;
  if (!Number.isFinite(squaredDistance) || squaredDistance > 1) {
    fail(
      ctx,
      "SCENE_INVALID_GRADIENT",
      `Radial gradient focal point (${focalX}, ${focalY}) lies outside radius ${r} of center.`,
      location,
    );
  }

  let gradientUnits: "userSpaceOnUse" | "objectBoundingBox" | undefined;
  if (obj["gradientUnits"] !== undefined) {
    const gu = obj["gradientUnits"];
    if (gu !== "userSpaceOnUse" && gu !== "objectBoundingBox") {
      fail(ctx, "SCENE_INVALID_ENUM", "gradientUnits must be userSpaceOnUse or objectBoundingBox.", `${location}.gradientUnits`);
    }
    gradientUnits = gu;
  }

  if (obj["spreadMethod"] !== undefined && obj["spreadMethod"] !== "pad") {
    fail(ctx, "SCENE_UNSUPPORTED_SPREAD", "Only pad spreadMethod is supported in Tier 1.", `${location}.spreadMethod`);
  }

  const rawStops = obj["stops"];
  if (!Array.isArray(rawStops) || rawStops.length < 2) {
    fail(ctx, "SCENE_INVALID_STOPS", "Gradient requires at least 2 stops.", `${location}.stops`);
  }
  if (rawStops.length > SCENE_LIMITS.maxGradientStops) {
    fail(
      ctx,
      "SCENE_LIMIT_EXCEEDED",
      `Gradient stop count ${rawStops.length} exceeds maximum allowed (${SCENE_LIMITS.maxGradientStops}).`,
      `${location}.stops`,
    );
  }

  const stops: GradientStop[] = [];
  let prevOffset = -1;
  for (let i = 0; i < rawStops.length; i += 1) {
    const stop = validateGradientStop(rawStops[i], ctx, `${location}.stops[${i}]`, tokenBindings, definedGradients);
    if (stop.offset < prevOffset) {
      fail(ctx, "SCENE_INVALID_STOPS", "Gradient stop offsets must be monotonically non-decreasing.", `${location}.stops[${i}]`);
    }
    prevOffset = stop.offset;
    stops.push(stop);
  }

  return {
    id,
    type: "radialGradient",
    cx: obj["cx"] as number,
    cy: obj["cy"] as number,
    r,
    ...(fx !== undefined ? { fx } : {}),
    ...(fy !== undefined ? { fy } : {}),
    ...(gradientUnits !== undefined ? { gradientUnits } : {}),
    ...(obj["spreadMethod"] !== undefined ? { spreadMethod: "pad" } : {}),
    stops,
  };
}

export function validateArtboard(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
): Artboard {
  if (typeof value !== "object" || value === null) {
    fail(ctx, "SCENE_INVALID_ARTBOARD", "Artboard must be an object.", location);
  }
  const obj = value as Record<string, unknown>;
  assertAllowedKeys(obj, ["width", "height", "viewBox", "policy"], ctx, location);

  const width = obj["width"];
  const height = obj["height"];
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
    fail(ctx, "SCENE_INVALID_NUMBER", "Artboard width must be a positive finite number.", `${location}.width`);
  }
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
    fail(ctx, "SCENE_INVALID_NUMBER", "Artboard height must be a positive finite number.", `${location}.height`);
  }

  const vb = obj["viewBox"];
  if (!Array.isArray(vb) || vb.length !== 4) {
    fail(ctx, "SCENE_INVALID_VIEW_BOX", "viewBox must be an array of 4 numbers.", `${location}.viewBox`);
  }
  for (let i = 0; i < 4; i += 1) {
    const v = vb[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      fail(ctx, "SCENE_INVALID_NUMBER", `viewBox[${i}] must be a finite number.`, `${location}.viewBox[${i}]`);
    }
  }
  if ((vb[2] as number) <= 0 || (vb[3] as number) <= 0) {
    fail(ctx, "SCENE_INVALID_VIEW_BOX", "viewBox width and height must be positive numbers.", `${location}.viewBox`);
  }

  let policy: "contain" | "pad" | undefined;
  if (obj["policy"] !== undefined) {
    const pol = obj["policy"];
    if (pol !== "contain" && pol !== "pad") {
      fail(ctx, "SCENE_INVALID_ENUM", "policy must be 'contain' or 'pad'.", `${location}.policy`);
    }
    policy = pol;
  }

  return {
    width,
    height,
    viewBox: [vb[0] as number, vb[1] as number, vb[2] as number, vb[3] as number],
    ...(policy !== undefined ? { policy } : {}),
  };
}

export function validateAccessibility(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
): SceneAccessibility {
  if (typeof value !== "object" || value === null) {
    fail(ctx, "SCENE_INVALID_ACCESSIBILITY", "Accessibility must be an object.", location);
  }
  const obj = value as Record<string, unknown>;
  const mode = obj["mode"];

  if (mode === "labelled") {
    assertAllowedKeys(obj, ["mode", "title", "desc", "focusable"], ctx, location);
    const title = obj["title"];
    if (typeof title !== "string" || title.trim() === "") {
      fail(ctx, "SCENE_INVALID_ACCESSIBILITY", "Labelled scene requires a non-empty title.", `${location}.title`);
    }
    let desc: string | undefined;
    if (obj["desc"] !== undefined) {
      if (typeof obj["desc"] !== "string" || obj["desc"].trim() === "") {
        fail(ctx, "SCENE_INVALID_ACCESSIBILITY", "Description must be a non-empty string if provided.", `${location}.desc`);
      }
      desc = obj["desc"].trim();
    }
    let focusable: boolean | undefined;
    if (obj["focusable"] !== undefined) {
      if (typeof obj["focusable"] !== "boolean") {
        fail(ctx, "SCENE_INVALID_BOOLEAN", "focusable must be boolean.", `${location}.focusable`);
      }
      focusable = obj["focusable"];
    }
    if (Buffer.byteLength(title) > 4096 || (desc !== undefined && Buffer.byteLength(desc) > 4096)) fail(ctx, "SCENE_LIMIT_EXCEEDED", "Accessibility strings exceed 4096 bytes.", location);
    return {
      mode: "labelled",
      title: title.trim(),
      ...(desc !== undefined ? { desc } : {}),
      ...(focusable !== undefined ? { focusable } : {}),
    };
  } else if (mode === "decorative") {
    if (obj["focusable"] === true) fail(ctx, "SCENE_INVALID_ACCESSIBILITY", "Decorative scenes cannot be focusable.", location);
    assertAllowedKeys(obj, ["mode", "focusable"], ctx, location);
    let focusable: boolean | undefined;
    if (obj["focusable"] !== undefined) {
      if (typeof obj["focusable"] !== "boolean") {
        fail(ctx, "SCENE_INVALID_BOOLEAN", "focusable must be boolean.", `${location}.focusable`);
      }
      focusable = obj["focusable"];
    }
    return {
      mode: "decorative",
      ...(focusable !== undefined ? { focusable } : {}),
    };
  } else {
    fail(
      ctx,
      "SCENE_INVALID_ACCESSIBILITY",
      "Accessibility mode must be 'labelled' or 'decorative'.",
      `${location}.mode`,
    );
  }
}

/**
 * Validate an authored element and its subtree.
 */
function validateElement(
  raw: unknown,
  ctx: DiagnosticContext,
  location: string,
  depth: number,
  state: {
    seenIds: Set<string>;
    glyphCount: number;
    pathSegmentCount: number;
    maxDepth: number;
    authoredElementCount: number;
  },
  tokenBindings?: Readonly<Record<string, HexColor>>,
  definedGradients?: ReadonlySet<string>,
): SceneElement {
  state.authoredElementCount += 1;
  if (state.authoredElementCount > SCENE_LIMITS.maxAuthoredElements) {
    fail(
      ctx,
      "SCENE_LIMIT_EXCEEDED",
      `Authored element count exceeds maximum allowed (${SCENE_LIMITS.maxAuthoredElements}).`,
      location,
    );
  }

  if (depth > state.maxDepth) {
    state.maxDepth = depth;
  }
  if (depth > SCENE_LIMITS.maxNestingDepth) {
    fail(
      ctx,
      "SCENE_LIMIT_EXCEEDED",
      `Nesting depth ${depth} exceeds maximum allowed (${SCENE_LIMITS.maxNestingDepth}).`,
      location,
    );
  }

  if (typeof raw !== "object" || raw === null) {
    fail(ctx, "SCENE_INVALID_ELEMENT", "Element must be an object.", location);
  }
  const obj = raw as Record<string, unknown>;
  const type = obj["type"];

  let id: string | undefined;
  if (obj["id"] !== undefined) {
    const rawId = obj["id"];
    if (typeof rawId !== "string" || !isLocalId(rawId)) {
      fail(ctx, "SCENE_INVALID_ID", "Element id must be a valid local id.", `${location}.id`);
    }
    if (state.seenIds.has(rawId)) {
      fail(ctx, "SCENE_DUPLICATE_ID", `Duplicate element id '${rawId}'.`, `${location}.id`);
    }
    state.seenIds.add(rawId);
    id = rawId;
  }

  const presentation = validatePresentation(obj["presentation"], ctx, `${location}.presentation`, tokenBindings, definedGradients);

  let transforms: readonly TransformOperation[] | undefined;
  if (obj["transform"] !== undefined) {
    if (!Array.isArray(obj["transform"])) {
      fail(ctx, "SCENE_INVALID_TRANSFORM", "transform must be an array of operations.", `${location}.transform`);
    }
    transforms = validateTransformOperations(obj["transform"], ctx, `${location}.transform`);
  }

  let explicitBounds: import("./types.js").ElementBounds | undefined;
  if (obj["bounds"] !== undefined) {
    const b = obj["bounds"];
    if (!Array.isArray(b) || b.length !== 4) {
      fail(ctx, "SCENE_INVALID_ARRAY", "bounds must be an array of 4 numbers.", `${location}.bounds`);
    }
    for (let i = 0; i < 4; i += 1) {
      if (typeof b[i] !== "number" || !Number.isFinite(b[i])) {
        fail(ctx, "SCENE_INVALID_NUMBER", `bounds[${i}] must be a finite number.`, `${location}.bounds[${i}]`);
      }
    }
    explicitBounds = [b[0] as number, b[1] as number, b[2] as number, b[3] as number];
  }

  const base: BaseElement = {
    ...(id !== undefined ? { id } : {}),
    ...(presentation !== undefined ? { presentation } : {}),
    ...(transforms !== undefined ? { transform: transforms } : {}),
    ...(explicitBounds !== undefined ? { bounds: explicitBounds } : {}),
  };

  switch (type) {
    case "path": {
      assertAllowedKeys(obj, ["type", "id", "presentation", "transform", "bounds", "d"], ctx, location);
      const d = obj["d"];
      if (typeof d !== "string") {
        fail(ctx, "SCENE_INVALID_PATH_DATA", "path d must be a string.", `${location}.d`);
      }
      if (Buffer.byteLength(d, "utf8") > SCENE_LIMITS.maxPathBytes) {
        fail(
          ctx,
          "SCENE_LIMIT_EXCEEDED",
          `Path data exceeds maximum allowed bytes (${SCENE_LIMITS.maxPathBytes}).`,
          `${location}.d`,
        );
      }
      parsePathData(d, ctx, `${location}.d`);
      const segs = countPathSegments(d);
      state.pathSegmentCount += segs;
      return { type: "path", ...base, d };
    }

    case "rect": {
      assertAllowedKeys(obj, ["type", "id", "presentation", "transform", "bounds", "x", "y", "width", "height", "rx", "ry"], ctx, location);
      for (const k of ["x", "y", "width", "height"] as const) {
        const v = obj[k];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          fail(ctx, "SCENE_INVALID_NUMBER", `${k} must be a finite number.`, `${location}.${k}`);
        }
      }
      const width = obj["width"] as number;
      const height = obj["height"] as number;
      if (width < 0 || height < 0) {
        fail(ctx, "SCENE_INVALID_NUMBER", "rect width and height must be non-negative.", location);
      }
      let rx = obj["rx"] !== undefined ? (obj["rx"] as number) : undefined;
      let ry = obj["ry"] !== undefined ? (obj["ry"] as number) : undefined;
      if (rx !== undefined) {
        if (typeof rx !== "number" || !Number.isFinite(rx) || rx < 0) {
          fail(ctx, "SCENE_INVALID_NUMBER", "rx must be non-negative.", `${location}.rx`);
        }
        rx = Math.min(rx, width / 2);
      }
      if (ry !== undefined) {
        if (typeof ry !== "number" || !Number.isFinite(ry) || ry < 0) {
          fail(ctx, "SCENE_INVALID_NUMBER", "ry must be non-negative.", `${location}.ry`);
        }
        ry = Math.min(ry, height / 2);
      }
      state.pathSegmentCount += 4;
      return {
        type: "rect",
        ...base,
        x: obj["x"] as number,
        y: obj["y"] as number,
        width,
        height,
        ...(rx !== undefined ? { rx } : {}),
        ...(ry !== undefined ? { ry } : {}),
      };
    }

    case "circle": {
      assertAllowedKeys(obj, ["type", "id", "presentation", "transform", "bounds", "cx", "cy", "r"], ctx, location);
      for (const k of ["cx", "cy"] as const) {
        const v = obj[k];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          fail(ctx, "SCENE_INVALID_NUMBER", `${k} must be a finite number.`, `${location}.${k}`);
        }
      }
      const r = obj["r"];
      if (typeof r !== "number" || !Number.isFinite(r) || r < 0) {
        fail(ctx, "SCENE_INVALID_NUMBER", "circle r must be a non-negative finite number.", `${location}.r`);
      }
      state.pathSegmentCount += 4;
      return {
        type: "circle",
        ...base,
        cx: obj["cx"] as number,
        cy: obj["cy"] as number,
        r,
      };
    }

    case "ellipse": {
      assertAllowedKeys(obj, ["type", "id", "presentation", "transform", "bounds", "cx", "cy", "rx", "ry"], ctx, location);
      for (const k of ["cx", "cy"] as const) {
        const v = obj[k];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          fail(ctx, "SCENE_INVALID_NUMBER", `${k} must be a finite number.`, `${location}.${k}`);
        }
      }
      for (const k of ["rx", "ry"] as const) {
        const v = obj[k];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
          fail(ctx, "SCENE_INVALID_NUMBER", `${k} must be a non-negative finite number.`, `${location}.${k}`);
        }
      }
      state.pathSegmentCount += 4;
      return {
        type: "ellipse",
        ...base,
        cx: obj["cx"] as number,
        cy: obj["cy"] as number,
        rx: obj["rx"] as number,
        ry: obj["ry"] as number,
      };
    }

    case "line": {
      assertAllowedKeys(obj, ["type", "id", "presentation", "transform", "bounds", "x1", "y1", "x2", "y2"], ctx, location);
      for (const k of ["x1", "y1", "x2", "y2"] as const) {
        const v = obj[k];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          fail(ctx, "SCENE_INVALID_NUMBER", `${k} must be a finite number.`, `${location}.${k}`);
        }
      }
      state.pathSegmentCount += 1;
      return {
        type: "line",
        ...base,
        x1: obj["x1"] as number,
        y1: obj["y1"] as number,
        x2: obj["x2"] as number,
        y2: obj["y2"] as number,
      };
    }

    case "polyline":
    case "polygon": {
      assertAllowedKeys(obj, ["type", "id", "presentation", "transform", "bounds", "points"], ctx, location);
      const pts = obj["points"];
      const minPts = type === "polyline" ? 2 : 3;
      if (!Array.isArray(pts) || pts.length < minPts) {
        fail(ctx, "SCENE_INVALID_POINTS", `${type} requires at least ${minPts} points.`, `${location}.points`);
      }
      const points: (readonly [number, number])[] = [];
      for (let i = 0; i < pts.length; i += 1) {
        const p = pts[i];
        if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "number" || typeof p[1] !== "number" || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
          fail(ctx, "SCENE_INVALID_POINTS", `Invalid point at ${location}.points[${i}].`, `${location}.points[${i}]`);
        }
        points.push([p[0], p[1]]);
      }
      state.pathSegmentCount += type === "polyline" ? points.length - 1 : points.length;
      return {
        type,
        ...base,
        points,
      };
    }

    case "group": {
      assertAllowedKeys(obj, ["type", "id", "presentation", "transform", "bounds", "children"], ctx, location);
      const ch = obj["children"];
      if (!Array.isArray(ch) || ch.length === 0) {
        fail(ctx, "SCENE_INVALID_GROUP", "group must contain non-empty children array.", `${location}.children`);
      }
      const children = ch.map((child, idx) =>
        validateElement(child, ctx, `${location}.children[${idx}]`, depth + 1, state, tokenBindings, definedGradients),
      );
      return {
        type: "group",
        ...base,
        children,
      };
    }

    case "use": {
      assertAllowedKeys(obj, ["type", "id", "presentation", "transform", "bounds", "href", "x", "y", "width", "height"], ctx, location);
      const href = obj["href"];
      if (typeof href !== "string" || !href.startsWith("#") || href.length === 1) {
        fail(ctx, "SCENE_INVALID_HREF", "use href must be an asset-local reference '#symbol-id'.", `${location}.href`);
      }
      const x = obj["x"] !== undefined ? (obj["x"] as number) : undefined;
      const y = obj["y"] !== undefined ? (obj["y"] as number) : undefined;
      const width = obj["width"] !== undefined ? (obj["width"] as number) : undefined;
      const height = obj["height"] !== undefined ? (obj["height"] as number) : undefined;
      for (const [v, name] of [[x, "x"], [y, "y"], [width, "width"], [height, "height"]] as const) {
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
          fail(ctx, "SCENE_INVALID_NUMBER", `${name} must be a finite number.`, `${location}.${name}`);
        }
      }
      if (width !== undefined && width <= 0) {
        fail(ctx, "SCENE_INVALID_NUMBER", "use width must be positive.", `${location}.width`);
      }
      if (height !== undefined && height <= 0) {
        fail(ctx, "SCENE_INVALID_NUMBER", "use height must be positive.", `${location}.height`);
      }
      return {
        type: "use",
        ...base,
        href,
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      };
    }

    case "diagramNode": {
      assertAllowedKeys(
        obj,
        ["type", "id", "presentation", "transform", "bounds", "x", "y", "width", "height", "rx", "ry", "label", "labelColor", "labelScale"],
        ctx,
        location,
      );
      if (id === undefined) {
        fail(ctx, "SCENE_MISSING_ID", "diagramNode requires an id.", `${location}.id`);
      }
      for (const k of ["x", "y", "width", "height"] as const) {
        const v = obj[k];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          fail(ctx, "SCENE_INVALID_NUMBER", `${k} must be a finite number.`, `${location}.${k}`);
        }
      }
      const width = obj["width"] as number;
      const height = obj["height"] as number;
      if (width <= 0 || height <= 0) {
        fail(ctx, "SCENE_INVALID_NUMBER", "diagramNode width and height must be positive.", location);
      }
      let rx = obj["rx"] !== undefined ? (obj["rx"] as number) : undefined;
      let ry = obj["ry"] !== undefined ? (obj["ry"] as number) : undefined;
      if (rx !== undefined) {
        if (typeof rx !== "number" || !Number.isFinite(rx) || rx < 0) {
          fail(ctx, "SCENE_INVALID_NUMBER", "rx must be non-negative.", `${location}.rx`);
        }
        rx = Math.min(rx, width / 2);
      }
      if (ry !== undefined) {
        if (typeof ry !== "number" || !Number.isFinite(ry) || ry < 0) {
          fail(ctx, "SCENE_INVALID_NUMBER", "ry must be non-negative.", `${location}.ry`);
        }
        ry = Math.min(ry, height / 2);
      }

      state.pathSegmentCount += 4; // Node rect

      let labelText: string | undefined;
      let labelColor: Paint | undefined;
      let labelScale: number | undefined;

      if (obj["label"] !== undefined) {
        if (typeof obj["label"] !== "string") {
          fail(ctx, "SCENE_INVALID_LABEL", "label must be a string.", `${location}.label`);
        }
        validateLabelText(obj["label"], ctx, `${location}.label`);
        const chars = countLabelGlyphs(obj["label"]);
        state.glyphCount += chars;
        state.pathSegmentCount += countTextPathSegments(obj["label"]);
        labelText = obj["label"];
      }

      if (obj["labelColor"] !== undefined) {
        labelColor = validatePaint(obj["labelColor"], ctx, `${location}.labelColor`, tokenBindings, definedGradients);
      }
      if (obj["labelScale"] !== undefined) {
        const ls = obj["labelScale"];
        if (typeof ls !== "number" || !Number.isFinite(ls) || ls <= 0) {
          fail(ctx, "SCENE_INVALID_NUMBER", "labelScale must be positive.", `${location}.labelScale`);
        }
        labelScale = ls;
      }

      return {
        type: "diagramNode",
        ...base,
        id,
        x: obj["x"] as number,
        y: obj["y"] as number,
        width,
        height,
        ...(rx !== undefined ? { rx } : {}),
        ...(ry !== undefined ? { ry } : {}),
        ...(labelText !== undefined ? { label: labelText } : {}),
        ...(labelColor !== undefined ? { labelColor } : {}),
        ...(labelScale !== undefined ? { labelScale } : {}),
      };
    }

    case "connector": {
      assertAllowedKeys(
        obj,
        ["type", "id", "presentation", "transform", "bounds", "routing", "from", "to", "waypoints", "startArrowhead", "endArrowhead", "arrowheadSize"],
        ctx,
        location,
      );
      const routing = obj["routing"];
      if (routing !== "straight" && routing !== "orthogonal") {
        fail(ctx, "SCENE_INVALID_ENUM", "connector routing must be 'straight' or 'orthogonal'.", `${location}.routing`);
      }

      function parseEndpoint(ep: unknown, epLoc: string): ConnectorEndpoint {
        if (typeof ep !== "object" || ep === null) {
          fail(ctx, "SCENE_INVALID_ENDPOINT", "Connector endpoint must be an object.", epLoc);
        }
        const epObj = ep as Record<string, unknown>;
        if ("elementId" in epObj) {
          assertAllowedKeys(epObj, ["elementId", "anchor"], ctx, epLoc);
          const elId = epObj["elementId"];
          if (typeof elId !== "string" || !isLocalId(elId)) {
            fail(ctx, "SCENE_INVALID_ID", "elementId must be a valid local id.", `${epLoc}.elementId`);
          }
          const anchor = epObj["anchor"];
          if (typeof anchor !== "string" || !ANCHOR_NAMES.has(anchor as CardinalAnchor)) {
            fail(ctx, "SCENE_INVALID_ENUM", "anchor must be top, bottom, left, right, or center.", `${epLoc}.anchor`);
          }
          return { elementId: elId, anchor: anchor as CardinalAnchor };
        } else if ("x" in epObj && "y" in epObj) {
          assertAllowedKeys(epObj, ["x", "y"], ctx, epLoc);
          if (typeof epObj["x"] !== "number" || !Number.isFinite(epObj["x"])) {
            fail(ctx, "SCENE_INVALID_NUMBER", "x must be a finite number.", `${epLoc}.x`);
          }
          if (typeof epObj["y"] !== "number" || !Number.isFinite(epObj["y"])) {
            fail(ctx, "SCENE_INVALID_NUMBER", "y must be a finite number.", `${epLoc}.y`);
          }
          return { x: epObj["x"] as number, y: epObj["y"] as number };
        } else {
          fail(ctx, "SCENE_INVALID_ENDPOINT", "Endpoint must specify {elementId, anchor} or {x, y}.", epLoc);
        }
      }

      const from = parseEndpoint(obj["from"], `${location}.from`);
      const to = parseEndpoint(obj["to"], `${location}.to`);

      let waypoints: (readonly [number, number])[] | undefined;
      if (obj["waypoints"] !== undefined) {
        const wp = obj["waypoints"];
        if (!Array.isArray(wp)) {
          fail(ctx, "SCENE_INVALID_ARRAY", "waypoints must be an array.", `${location}.waypoints`);
        }
        waypoints = wp.map((pt, i) => {
          if (!Array.isArray(pt) || pt.length !== 2 || typeof pt[0] !== "number" || typeof pt[1] !== "number" || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
            fail(ctx, "SCENE_INVALID_NUMBER", `Waypoint at ${location}.waypoints[${i}] must be [x, y].`, `${location}.waypoints[${i}]`);
          }
          return [pt[0], pt[1]] as const;
        });
      }

      let startArrowhead: ArrowheadType | undefined;
      if (obj["startArrowhead"] !== undefined) {
        if (!ARROWHEAD_TYPES.has(obj["startArrowhead"] as ArrowheadType)) {
          fail(ctx, "SCENE_INVALID_ENUM", "startArrowhead must be none, triangle, or chevron.", `${location}.startArrowhead`);
        }
        startArrowhead = obj["startArrowhead"] as ArrowheadType;
      }

      let endArrowhead: ArrowheadType | undefined;
      if (obj["endArrowhead"] !== undefined) {
        if (!ARROWHEAD_TYPES.has(obj["endArrowhead"] as ArrowheadType)) {
          fail(ctx, "SCENE_INVALID_ENUM", "endArrowhead must be none, triangle, or chevron.", `${location}.endArrowhead`);
        }
        endArrowhead = obj["endArrowhead"] as ArrowheadType;
      }

      let arrowheadSize: number | undefined;
      if (obj["arrowheadSize"] !== undefined) {
        const as = obj["arrowheadSize"];
        if (typeof as !== "number" || !Number.isFinite(as) || as <= 0) {
          fail(ctx, "SCENE_INVALID_NUMBER", "arrowheadSize must be positive.", `${location}.arrowheadSize`);
        }
        arrowheadSize = as;
      }

      let segs = routing === "orthogonal" ? 3 : 1;
      if (waypoints && waypoints.length > 0) segs = waypoints.length + 1;
      if (startArrowhead && startArrowhead !== "none") segs += 3;
      if (endArrowhead && endArrowhead !== "none") segs += 3;
      state.pathSegmentCount += segs;

      return {
        type: "connector",
        ...base,
        routing,
        from,
        to,
        ...(waypoints !== undefined ? { waypoints } : {}),
        ...(startArrowhead !== undefined ? { startArrowhead } : {}),
        ...(endArrowhead !== undefined ? { endArrowhead } : {}),
        ...(arrowheadSize !== undefined ? { arrowheadSize } : {}),
      };
    }

    case "label": {
      assertAllowedKeys(
        obj,
        ["type", "id", "presentation", "transform", "bounds", "text", "x", "y", "scale", "color", "lineSpacing", "align"],
        ctx,
        location,
      );
      const text = obj["text"];
      if (typeof text !== "string") {
        fail(ctx, "SCENE_INVALID_LABEL", "label text must be a string.", `${location}.text`);
      }
      validateLabelText(text, ctx, `${location}.text`);
      const glyphs = countLabelGlyphs(text);
      state.glyphCount += glyphs;
      state.pathSegmentCount += countTextPathSegments(text);

      for (const k of ["x", "y"] as const) {
        const v = obj[k];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          fail(ctx, "SCENE_INVALID_NUMBER", `${k} must be a finite number.`, `${location}.${k}`);
        }
      }

      let scale: number | undefined;
      if (obj["scale"] !== undefined) {
        const sc = obj["scale"];
        if (typeof sc !== "number" || !Number.isFinite(sc) || sc <= 0) {
          fail(ctx, "SCENE_INVALID_NUMBER", "scale must be positive.", `${location}.scale`);
        }
        scale = sc;
      }

      let color: Paint | undefined;
      if (obj["color"] !== undefined) {
        color = validatePaint(obj["color"], ctx, `${location}.color`, tokenBindings, definedGradients);
      }

      let lineSpacing: number | undefined;
      if (obj["lineSpacing"] !== undefined) {
        const ls = obj["lineSpacing"];
        if (typeof ls !== "number" || !Number.isFinite(ls) || ls <= 0) {
          fail(ctx, "SCENE_INVALID_NUMBER", "lineSpacing must be positive.", `${location}.lineSpacing`);
        }
        lineSpacing = ls;
      }

      let align: "left" | "center" | "right" | undefined;
      if (obj["align"] !== undefined) {
        const al = obj["align"];
        if (al !== "left" && al !== "center" && al !== "right") {
          fail(ctx, "SCENE_INVALID_ENUM", "align must be left, center, or right.", `${location}.align`);
        }
        align = al;
      }

      return {
        type: "label",
        ...base,
        text,
        x: obj["x"] as number,
        y: obj["y"] as number,
        ...(scale !== undefined ? { scale } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(lineSpacing !== undefined ? { lineSpacing } : {}),
        ...(align !== undefined ? { align } : {}),
      };
    }

    default: {
      fail(
        ctx,
        "SCENE_UNSUPPORTED_ELEMENT",
        `Unsupported element type '${String(type)}'.`,
        `${location}.type`,
      );
    }
  }
}

/**
 * Resolve token bindings with cycle and missing reference detection.
 * Token aliases like 'token:target' are resolved to canonical HexColor values.
 */
export function resolveTokenBindings(
  raw: unknown,
  ctx: DiagnosticContext,
  location: string = "$.tokenBindings",
): Record<string, HexColor> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(ctx, "SCENE_INVALID_TOKENS", "tokenBindings must be an object.", location);
  }
  const rawObj = raw as Record<string, unknown>;
  const keys = Object.keys(rawObj);
  if (keys.length > SCENE_LIMITS.maxTokens) {
    fail(
      ctx,
      "SCENE_LIMIT_EXCEEDED",
      `Token bindings count ${keys.length} exceeds maximum allowed (${SCENE_LIMITS.maxTokens}).`,
      location,
    );
  }

  for (const k of keys) {
    if (typeof k !== "string" || !LOCAL_ID_PATTERN.test(k)) {
      fail(ctx, "SCENE_INVALID_TOKEN", `Invalid token name '${k}'.`, `${location}.${k}`);
    }
  }

  const resolved = new Map<string, HexColor>();
  const visiting = new Set<string>();

  function resolveToken(name: string, chain: string[]): HexColor {
    if (resolved.has(name)) {
      return resolved.get(name)!;
    }
    if (visiting.has(name)) {
      fail(
        ctx,
        "SCENE_CYCLIC_REFERENCE",
        `Cyclic token alias reference: ${[...chain, name].join(" -> ")}`,
        `${location}.${name}`,
      );
    }
    if (!Object.hasOwn(rawObj, name)) {
      fail(
        ctx,
        "SCENE_UNRESOLVED_TOKEN",
        `Token alias '${chain.at(-1) ?? name}' references undefined token '${name}'.`,
        `${location}.${name}`,
      );
    }

    visiting.add(name);
    const val = rawObj[name];

    if (typeof val !== "string") {
      fail(ctx, "SCENE_INVALID_COLOR", `Token '${name}' must be a hex color or alias string.`, `${location}.${name}`);
    }

    let finalColor: HexColor;
    if (val.startsWith("token:")) {
      const target = val.slice(6).trim();
      if (target === "") {
        fail(ctx, "SCENE_INVALID_TOKEN", `Empty target in token alias '${val}'.`, `${location}.${name}`);
      }
      if (!LOCAL_ID_PATTERN.test(target)) {
        fail(ctx, "SCENE_INVALID_TOKEN", `Invalid target '${target}' in token alias '${val}'.`, `${location}.${name}`);
      }
      finalColor = resolveToken(target, [...chain, name]);
    } else {
      finalColor = parseHexColor(val, ctx, `${location}.${name}`);
    }

    visiting.delete(name);
    resolved.set(name, finalColor);
    return finalColor;
  }

  const result: Record<string, HexColor> = Object.create(null);
  for (const k of keys) {
    result[k] = resolveToken(k, []);
  }

  return result;
}

function containsPrivateOrAbsolutePath(str: string): boolean {
  if (/^(?:[a-zA-Z]:[/\\]|\/|~[/\\]|\\\\)/.test(str)) {
    return true;
  }
  if (/[/\\](?:home|Users|etc|root|private|var|opt)[/\\]/i.test(str)) {
    return true;
  }
  return false;
}

/**
 * Validate provenance metadata strictly: closed keys, length bounds, no private paths.
 */
export function validateProvenance(
  raw: unknown,
  ctx: DiagnosticContext,
  location: string = "$.provenance",
): SceneProvenance {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(ctx, "SCENE_INVALID_PROVENANCE", "Provenance must be an object.", location);
  }
  const obj = raw as Record<string, unknown>;
  assertAllowedKeys(obj, ["author", "license", "sourceDigest", "created", "note"], ctx, location);

  const bounds: Record<string, number> = {
    author: 256,
    license: 128,
    sourceDigest: 128,
    created: 64,
    note: 1024,
  };

  const result: Record<string, string> = {};

  for (const [key, maxLen] of Object.entries(bounds)) {
    if (obj[key] !== undefined) {
      const val = obj[key];
      if (typeof val !== "string") {
        fail(ctx, "SCENE_INVALID_PROVENANCE", `Provenance property '${key}' must be a string.`, `${location}.${key}`);
      }
      const trimmed = val.trim();
      if (trimmed === "") {
        fail(ctx, "SCENE_INVALID_PROVENANCE", `Provenance property '${key}' cannot be empty.`, `${location}.${key}`);
      }
      if (trimmed.length > maxLen) {
        fail(ctx, "SCENE_LIMIT_EXCEEDED", `Provenance property '${key}' exceeds maximum length (${maxLen}).`, `${location}.${key}`);
      }
      if (containsPrivateOrAbsolutePath(trimmed)) {
        fail(ctx, "SCENE_INVALID_PROVENANCE", `Provenance property '${key}' contains an absolute or private filesystem path.`, `${location}.${key}`);
      }
      if (key === "sourceDigest" && !/^sha256:[0-9a-f]{64}$/.test(trimmed)) fail(ctx, "SCENE_INVALID_PROVENANCE", "Source digest must be a SHA-256 identity.", location);
      result[key] = trimmed;
    }
  }

  return result as SceneProvenance;
}

/**
 * Validate layout directives: closed keys, expected types, IDs, finite bounds.
 */
export function validateLayoutDirectives(
  raw: unknown,
  ctx: DiagnosticContext,
  location: string = "$.layout",
): LayoutDirective[] {
  if (!Array.isArray(raw)) {
    fail(ctx, "SCENE_INVALID_ARRAY", "layout must be an array.", location);
  }
  if (raw.length > SCENE_LIMITS.maxLayoutDirectives) {
    fail(
      ctx,
      "SCENE_LIMIT_EXCEEDED",
      `Layout directives count ${raw.length} exceeds maximum allowed (${SCENE_LIMITS.maxLayoutDirectives}).`,
      location,
    );
  }

  const result: LayoutDirective[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const d = raw[i];
    const loc = `${location}[${i}]`;
    if (typeof d !== "object" || d === null || Array.isArray(d)) {
      fail(ctx, "SCENE_INVALID_LAYOUT", "Layout directive must be an object.", loc);
    }
    const dObj = d as Record<string, unknown>;
    const type = dObj["type"];

    switch (type) {
      case "align": {
        assertAllowedKeys(dObj, ["type", "alignment", "targets", "relativeTo"], ctx, loc);
        const alignment = dObj["alignment"];
        const validAlignments = ["left", "center", "right", "top", "middle", "bottom"];
        if (typeof alignment !== "string" || !validAlignments.includes(alignment)) {
          fail(ctx, "SCENE_INVALID_ENUM", `alignment must be one of: ${validAlignments.join(", ")}.`, `${loc}.alignment`);
        }
        const rawTargets = dObj["targets"];
        if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
          fail(ctx, "SCENE_INVALID_TARGETS", "align targets must be a non-empty array of ids.", `${loc}.targets`);
        }
        const targets: string[] = [];
        for (let j = 0; j < rawTargets.length; j += 1) {
          const t = rawTargets[j];
          if (typeof t !== "string" || !isLocalId(t)) {
            fail(ctx, "SCENE_INVALID_ID", "align target must be a valid local id.", `${loc}.targets[${j}]`);
          }
          targets.push(t);
        }
        let relativeTo: string | undefined;
        if (dObj["relativeTo"] !== undefined) {
          const rt = dObj["relativeTo"];
          if (typeof rt !== "string" || !isLocalId(rt)) {
            fail(ctx, "SCENE_INVALID_ID", "align relativeTo must be a valid local id.", `${loc}.relativeTo`);
          }
          relativeTo = rt;
        }
        result.push({
          type: "align",
          alignment: alignment as any,
          targets,
          ...(relativeTo !== undefined ? { relativeTo } : {}),
        });
        break;
      }

      case "distribute": {
        assertAllowedKeys(dObj, ["type", "axis", "targets", "spacing"], ctx, loc);
        const axis = dObj["axis"];
        if (axis !== "horizontal" && axis !== "vertical") {
          fail(ctx, "SCENE_INVALID_ENUM", "distribute axis must be horizontal or vertical.", `${loc}.axis`);
        }
        const rawTargets = dObj["targets"];
        if (!Array.isArray(rawTargets) || rawTargets.length < 2) {
          fail(ctx, "SCENE_INVALID_TARGETS", "distribute targets must contain at least 2 ids.", `${loc}.targets`);
        }
        const targets: string[] = [];
        for (let j = 0; j < rawTargets.length; j += 1) {
          const t = rawTargets[j];
          if (typeof t !== "string" || !isLocalId(t)) {
            fail(ctx, "SCENE_INVALID_ID", "distribute target must be a valid local id.", `${loc}.targets[${j}]`);
          }
          targets.push(t);
        }
        let spacing: number | undefined;
        if (dObj["spacing"] !== undefined) {
          const sp = dObj["spacing"];
          if (typeof sp !== "number" || !Number.isFinite(sp) || sp < 0) {
            fail(ctx, "SCENE_INVALID_NUMBER", "distribute spacing must be a non-negative finite number.", `${loc}.spacing`);
          }
          spacing = sp;
        }
        result.push({
          type: "distribute",
          axis: axis as any,
          targets,
          ...(spacing !== undefined ? { spacing } : {}),
        });
        break;
      }

      case "grid": {
        assertAllowedKeys(dObj, ["type", "targets", "columns", "columnGap", "rowGap", "startX", "startY"], ctx, loc);
        const rawTargets = dObj["targets"];
        if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
          fail(ctx, "SCENE_INVALID_TARGETS", "grid targets must be a non-empty array of ids.", `${loc}.targets`);
        }
        const targets: string[] = [];
        for (let j = 0; j < rawTargets.length; j += 1) {
          const t = rawTargets[j];
          if (typeof t !== "string" || !isLocalId(t)) {
            fail(ctx, "SCENE_INVALID_ID", "grid target must be a valid local id.", `${loc}.targets[${j}]`);
          }
          targets.push(t);
        }
        const cols = dObj["columns"];
        if (typeof cols !== "number" || !Number.isInteger(cols) || cols < 1) {
          fail(ctx, "SCENE_INVALID_NUMBER", "grid columns must be an integer >= 1.", `${loc}.columns`);
        }
        let columnGap: number | undefined;
        if (dObj["columnGap"] !== undefined) {
          const cg = dObj["columnGap"];
          if (typeof cg !== "number" || !Number.isFinite(cg) || cg < 0) {
            fail(ctx, "SCENE_INVALID_NUMBER", "grid columnGap must be a non-negative finite number.", `${loc}.columnGap`);
          }
          columnGap = cg;
        }
        let rowGap: number | undefined;
        if (dObj["rowGap"] !== undefined) {
          const rg = dObj["rowGap"];
          if (typeof rg !== "number" || !Number.isFinite(rg) || rg < 0) {
            fail(ctx, "SCENE_INVALID_NUMBER", "grid rowGap must be a non-negative finite number.", `${loc}.rowGap`);
          }
          rowGap = rg;
        }
        let startX: number | undefined;
        if (dObj["startX"] !== undefined) {
          const sx = dObj["startX"];
          if (typeof sx !== "number" || !Number.isFinite(sx)) {
            fail(ctx, "SCENE_INVALID_NUMBER", "grid startX must be a finite number.", `${loc}.startX`);
          }
          startX = sx;
        }
        let startY: number | undefined;
        if (dObj["startY"] !== undefined) {
          const sy = dObj["startY"];
          if (typeof sy !== "number" || !Number.isFinite(sy)) {
            fail(ctx, "SCENE_INVALID_NUMBER", "grid startY must be a finite number.", `${loc}.startY`);
          }
          startY = sy;
        }
        result.push({
          type: "grid",
          targets,
          columns: cols,
          ...(columnGap !== undefined ? { columnGap } : {}),
          ...(rowGap !== undefined ? { rowGap } : {}),
          ...(startX !== undefined ? { startX } : {}),
          ...(startY !== undefined ? { startY } : {}),
        });
        break;
      }

      case "anchor": {
        assertAllowedKeys(dObj, ["type", "target", "targetAnchor", "relativeTo", "relativeToAnchor", "offsetX", "offsetY"], ctx, loc);
        const target = dObj["target"];
        if (typeof target !== "string" || !isLocalId(target)) {
          fail(ctx, "SCENE_INVALID_ID", "anchor target must be a valid local id.", `${loc}.target`);
        }
        const targetAnchor = dObj["targetAnchor"];
        if (typeof targetAnchor !== "string" || !ANCHOR_NAMES.has(targetAnchor as CardinalAnchor)) {
          fail(ctx, "SCENE_INVALID_ENUM", "targetAnchor must be top, bottom, left, right, or center.", `${loc}.targetAnchor`);
        }
        const relativeTo = dObj["relativeTo"];
        if (typeof relativeTo !== "string" || !isLocalId(relativeTo)) {
          fail(ctx, "SCENE_INVALID_ID", "anchor relativeTo must be a valid local id.", `${loc}.relativeTo`);
        }
        const relativeToAnchor = dObj["relativeToAnchor"];
        if (typeof relativeToAnchor !== "string" || !ANCHOR_NAMES.has(relativeToAnchor as CardinalAnchor)) {
          fail(ctx, "SCENE_INVALID_ENUM", "relativeToAnchor must be top, bottom, left, right, or center.", `${loc}.relativeToAnchor`);
        }
        if (target === relativeTo) {
          fail(ctx, "SCENE_CYCLIC_LAYOUT", `Element '${target}' cannot anchor to itself.`, loc);
        }
        let offsetX: number | undefined;
        if (dObj["offsetX"] !== undefined) {
          const ox = dObj["offsetX"];
          if (typeof ox !== "number" || !Number.isFinite(ox)) {
            fail(ctx, "SCENE_INVALID_NUMBER", "offsetX must be a finite number.", `${loc}.offsetX`);
          }
          offsetX = ox;
        }
        let offsetY: number | undefined;
        if (dObj["offsetY"] !== undefined) {
          const oy = dObj["offsetY"];
          if (typeof oy !== "number" || !Number.isFinite(oy)) {
            fail(ctx, "SCENE_INVALID_NUMBER", "offsetY must be a finite number.", `${loc}.offsetY`);
          }
          offsetY = oy;
        }
        result.push({
          type: "anchor",
          target,
          targetAnchor: targetAnchor as any,
          relativeTo,
          relativeToAnchor: relativeToAnchor as any,
          ...(offsetX !== undefined ? { offsetX } : {}),
          ...(offsetY !== undefined ? { offsetY } : {}),
        });
        break;
      }

      default: {
        fail(
          ctx,
          "SCENE_INVALID_LAYOUT",
          `Unsupported layout directive type '${String(type)}'.`,
          `${loc}.type`,
        );
      }
    }
  }

  return result;
}

function loweredElementCost(el: SceneElement): number {
  if (el.type === "diagramNode") return 2 + (el.label !== undefined && el.label.trim() !== "" ? 1 : 0);
  if (el.type === "connector") return 2 + (el.startArrowhead && el.startArrowhead !== "none" ? 1 : 0) + (el.endArrowhead && el.endArrowhead !== "none" ? 1 : 0);
  return 1;
}

interface SymbolCost {
  readonly elements: number;
  readonly glyphs: number;
  readonly pathSegments: number;
  readonly depth: number;
}

/**
 * Compute post-expansion resource costs per symbol using memoized DFS with cycle detection.
 */
function computeSymbolCosts(
  symbolDefs: readonly SymbolDef[],
  ctx: DiagnosticContext,
): Map<string, SymbolCost> {
  const symbolsMap = new Map<string, SymbolDef>();
  for (const s of symbolDefs) {
    symbolsMap.set(s.id, s);
  }

  const memo = new Map<string, SymbolCost>();
  const visiting = new Set<string>();

  function dfs(id: string, path: string[], depth: number): SymbolCost {
    if (depth > SCENE_LIMITS.maxSymbolDepth) {
      fail(
        ctx,
        "SCENE_LIMIT_EXCEEDED",
        `Symbol reference depth exceeds maximum allowed (${SCENE_LIMITS.maxSymbolDepth}).`,
        `definitions.symbols.${id}`,
      );
    }
    if (memo.has(id)) {
      const cached = memo.get(id)!;
      if (depth + cached.depth > SCENE_LIMITS.maxSymbolDepth) {
        fail(
          ctx,
          "SCENE_LIMIT_EXCEEDED",
          `Symbol reference depth exceeds maximum allowed (${SCENE_LIMITS.maxSymbolDepth}).`,
          `definitions.symbols.${id}`,
        );
      }
      return cached;
    }
    if (visiting.has(id)) {
      fail(
        ctx,
        "SCENE_CYCLIC_REFERENCE",
        `Cyclic symbol reference detected: ${[...path, id].join(" -> ")}`,
        `definitions.symbols.${id}`,
      );
    }

    visiting.add(id);
    const sym = symbolsMap.get(id);
    if (!sym) {
      fail(
        ctx,
        "SCENE_INVALID_USE_REFERENCE",
        `Unknown symbol reference '${id}'.`,
        `definitions.symbols.${path.at(-1) ?? id}`,
      );
    }

    let elements = 0;
    let glyphs = 0;
    let pathSegments = 0;
    let maxChildDepth = 0;

    function walk(el: SceneElement, elLoc: string): void {
      elements += loweredElementCost(el);
      if (elements > SCENE_LIMITS.maxExpandedElements) {
        fail(
          ctx,
          "SCENE_LIMIT_EXCEEDED",
          `Symbol '${id}' expanded elements exceed ceiling (${SCENE_LIMITS.maxExpandedElements}).`,
          elLoc,
        );
      }

      switch (el.type) {
        case "path":
          pathSegments += countPathSegments(el.d);
          break;
        case "rect":
        case "circle":
        case "ellipse":
          pathSegments += 4;
          break;
        case "line":
          pathSegments += 1;
          break;
        case "polyline":
          pathSegments += Math.max(1, el.points.length - 1);
          break;
        case "polygon":
          pathSegments += el.points.length;
          break;
        case "label": {
          const g = countLabelGlyphs(el.text);
          glyphs += g;
          pathSegments += countTextPathSegments(el.text);
          break;
        }
        case "diagramNode": {
          pathSegments += 4;
          if (el.label !== undefined && el.label.trim() !== "") {
            const g = countLabelGlyphs(el.label);
            glyphs += g;
            pathSegments += countTextPathSegments(el.label);
          }
          break;
        }
        case "connector": {
          let segs = el.routing === "orthogonal" ? 3 : 1;
          if (el.waypoints && el.waypoints.length > 0) segs = el.waypoints.length + 1;
          if (el.startArrowhead && el.startArrowhead !== "none") segs += 3;
          if (el.endArrowhead && el.endArrowhead !== "none") segs += 3;
          pathSegments += segs;
          break;
        }
        case "group":
          for (let i = 0; i < el.children.length; i += 1) {
            walk(el.children[i]!, `${elLoc}.children[${i}]`);
          }
          break;
        case "use": {
          const ref = el.href.startsWith("#") ? el.href.slice(1) : el.href;
          const childCost = dfs(ref, [...path, id], depth + 1);
          elements += childCost.elements;
          glyphs += childCost.glyphs;
          pathSegments += childCost.pathSegments;
          maxChildDepth = Math.max(maxChildDepth, childCost.depth + 1);
          break;
        }
      }
    }

    for (let i = 0; i < sym.elements.length; i += 1) {
      walk(sym.elements[i]!, `definitions.symbols.${id}.elements[${i}]`);
    }

    visiting.delete(id);

    if (elements > SCENE_LIMITS.maxSymbolAmplification) {
      fail(
        ctx,
        "SCENE_LIMIT_EXCEEDED",
        `Symbol '${id}' amplification factor (${elements}) exceeds maximum allowed (${SCENE_LIMITS.maxSymbolAmplification}).`,
        `definitions.symbols.${id}`,
      );
    }

    const cost: SymbolCost = {
      elements,
      glyphs,
      pathSegments,
      depth: maxChildDepth,
    };
    memo.set(id, cost);
    return cost;
  }

  for (const s of symbolDefs) {
    dfs(s.id, [], 0);
  }

  return memo;
}

/**
 * Validates a complete VectorScene. Accepts `unknown`.
 */
export function validateScene(input: unknown): Result<{
  readonly scene: VectorScene;
  readonly metrics: SceneMetrics;
}> {
  const ctx: DiagnosticContext = {
    operation: "validate",
    domain: "scene" as any,
  };

  try {
    // 1. Strict preflight before recursive parsing or allocation
    guardSceneInput(input, ctx);

    const root = input as Record<string, unknown>;
    assertAllowedKeys(
      root,
      [
        "schema",
        "compatibility",
        "compilerLevel",
        "profile",
        "artboard",
        "accessibility",
        "elements",
        "definitions",
        "tokenBindings",
        "layout",
        "provenance",
      ],
      ctx,
      "$",
    );

    if (root["schema"] !== SCENE_SCHEMA) {
      fail(
        ctx,
        "SCENE_UNSUPPORTED_SCHEMA",
        `Expected schema '${SCENE_SCHEMA}', got '${String(root["schema"])}'.`,
        "$.schema",
      );
    }
    if (root["compatibility"] !== SCENE_COMPATIBILITY) {
      fail(
        ctx,
        "SCENE_UNSUPPORTED_COMPATIBILITY",
        `Expected compatibility ${SCENE_COMPATIBILITY}, got ${String(root["compatibility"])}.`,
        "$.compatibility",
      );
    }
    const requiredCompilerLevel = root["compilerLevel"];
    if (typeof requiredCompilerLevel !== "number" || !Number.isInteger(requiredCompilerLevel) ||
        requiredCompilerLevel < 1 || requiredCompilerLevel > SCENE_COMPILER_LEVEL) {
      fail(
        ctx,
        "SCENE_UNSUPPORTED_COMPILER_LEVEL",
        `Expected a minimum compilerLevel from 1 through ${SCENE_COMPILER_LEVEL}, got ${String(requiredCompilerLevel)}.`,
        "$.compilerLevel",
      );
    }

    const profile = root["profile"];
    if (
      typeof profile !== "string" ||
      !SCENE_PROFILES.includes(profile as SceneProfile)
    ) {
      fail(
        ctx,
        "SCENE_INVALID_PROFILE",
        `Profile must be one of: ${SCENE_PROFILES.join(", ")}.`,
        "$.profile",
      );
    }

    const artboard = validateArtboard(root["artboard"], ctx, "$.artboard");
    const accessibility = validateAccessibility(root["accessibility"], ctx, "$.accessibility");

    // 2. Token bindings resolution
    let tokenBindings: Record<string, HexColor> | undefined;
    if (root["tokenBindings"] !== undefined) {
      tokenBindings = resolveTokenBindings(root["tokenBindings"], ctx, "$.tokenBindings");
    }

    // 3. Pre-scan definitions
    let definitions: SceneDefinitions | undefined;
    let gradientDefs: GradientDef[] = [];
    let symbolDefs: SymbolDef[] = [];
    let gradientStopCount = 0;
    const definedGradients = new Set<string>();

    const state = {
      seenIds: new Set<string>(),
      glyphCount: 0,
      pathSegmentCount: 0,
      maxDepth: 1,
      authoredElementCount: 0,
    };

    if (root["definitions"] !== undefined) {
      if (typeof root["definitions"] !== "object" || root["definitions"] === null) {
        fail(ctx, "SCENE_INVALID_DEFINITIONS", "definitions must be an object.", "$.definitions");
      }
      const defsObj = root["definitions"] as Record<string, unknown>;
      assertAllowedKeys(defsObj, ["gradients", "symbols"], ctx, "$.definitions");

      if (defsObj["gradients"] !== undefined) {
        const rawGrads = defsObj["gradients"];
        if (!Array.isArray(rawGrads)) {
          fail(ctx, "SCENE_INVALID_ARRAY", "gradients must be an array.", "$.definitions.gradients");
        }
        if (rawGrads.length > SCENE_LIMITS.maxDefinitions) {
          fail(
            ctx,
            "SCENE_LIMIT_EXCEEDED",
            `Gradient definition count ${rawGrads.length} exceeds maximum allowed (${SCENE_LIMITS.maxDefinitions}).`,
            "$.definitions.gradients",
          );
        }
        if (rawGrads.length > SCENE_LIMITS.maxDefinitions) fail(ctx, "SCENE_LIMIT_EXCEEDED", "Too many gradient definitions.", "$.definitions.gradients");
        for (let i = 0; i < rawGrads.length; i += 1) {
          const g = rawGrads[i];
          if (typeof g !== "object" || g === null) {
            fail(ctx, "SCENE_INVALID_GRADIENT", "Gradient must be an object.", `$.definitions.gradients[${i}]`);
          }
          const gType = (g as Record<string, unknown>)["type"];
          let parsedGradient: GradientDef;
          if (gType === "linearGradient") {
            parsedGradient = validateLinearGradient(g as Record<string, unknown>, ctx, `$.definitions.gradients[${i}]`, tokenBindings, definedGradients);
          } else if (gType === "radialGradient") {
            parsedGradient = validateRadialGradient(g as Record<string, unknown>, ctx, `$.definitions.gradients[${i}]`, tokenBindings, definedGradients);
          } else {
            fail(ctx, "SCENE_INVALID_GRADIENT", "Gradient type must be linearGradient or radialGradient.", `$.definitions.gradients[${i}].type`);
          }
          if (state.seenIds.has(parsedGradient.id)) {
            fail(ctx, "SCENE_DUPLICATE_ID", `Duplicate id '${parsedGradient.id}'.`, `$.definitions.gradients[${i}].id`);
          }
          state.seenIds.add(parsedGradient.id);
          definedGradients.add(parsedGradient.id);
          gradientDefs.push(parsedGradient);
          gradientStopCount += parsedGradient.stops.length;
        }
      }

      if (defsObj["symbols"] !== undefined) {
        const rawSymbols = defsObj["symbols"];
        if (!Array.isArray(rawSymbols)) {
          fail(ctx, "SCENE_INVALID_ARRAY", "symbols must be an array.", "$.definitions.symbols");
        }
        if (rawSymbols.length > SCENE_LIMITS.maxDefinitions) {
          fail(
            ctx,
            "SCENE_LIMIT_EXCEEDED",
            `Symbol definition count ${rawSymbols.length} exceeds maximum allowed (${SCENE_LIMITS.maxDefinitions}).`,
            "$.definitions.symbols",
          );
        }
        for (let i = 0; i < rawSymbols.length; i += 1) {
          const s = rawSymbols[i];
          if (typeof s !== "object" || s === null) {
            fail(ctx, "SCENE_INVALID_SYMBOL", "Symbol must be an object.", `$.definitions.symbols[${i}]`);
          }
          const sObj = s as Record<string, unknown>;
          assertAllowedKeys(sObj, ["id", "type", "viewBox", "elements"], ctx, `$.definitions.symbols[${i}]`);

          const sid = sObj["id"];
          if (typeof sid !== "string" || !isLocalId(sid)) {
            fail(ctx, "SCENE_INVALID_ID", "Symbol id must be a valid local id.", `$.definitions.symbols[${i}].id`);
          }
          if (state.seenIds.has(sid)) {
            fail(ctx, "SCENE_DUPLICATE_ID", `Duplicate id '${sid}'.`, `$.definitions.symbols[${i}].id`);
          }
          state.seenIds.add(sid);

          if (sObj["type"] !== "symbol") {
            fail(ctx, "SCENE_INVALID_SYMBOL", "Symbol type must be 'symbol'.", `$.definitions.symbols[${i}].type`);
          }

          const svb = sObj["viewBox"];
          if (!Array.isArray(svb) || svb.length !== 4) {
            fail(ctx, "SCENE_INVALID_VIEW_BOX", "Symbol viewBox must be an array of 4 numbers.", `$.definitions.symbols[${i}].viewBox`);
          }
          for (let c = 0; c < 4; c += 1) {
            if (typeof svb[c] !== "number" || !Number.isFinite(svb[c])) {
              fail(ctx, "SCENE_INVALID_NUMBER", `Symbol viewBox[${c}] must be a finite number.`, `$.definitions.symbols[${i}].viewBox[${c}]`);
            }
          }
          if ((svb[2] as number) <= 0 || (svb[3] as number) <= 0) {
            fail(ctx, "SCENE_INVALID_VIEW_BOX", "Symbol viewBox dimensions must be positive.", `$.definitions.symbols[${i}].viewBox`);
          }

          const sElements = sObj["elements"];
          if (!Array.isArray(sElements) || sElements.length === 0) {
            fail(ctx, "SCENE_INVALID_SYMBOL", "Symbol elements must be a non-empty array.", `$.definitions.symbols[${i}].elements`);
          }

          const validatedSymbolElements = sElements.map((el, elIdx) =>
            validateElement(el, ctx, `$.definitions.symbols[${i}].elements[${elIdx}]`, 1, state, tokenBindings, definedGradients),
          );

          symbolDefs.push({
            id: sid,
            type: "symbol",
            viewBox: [svb[0] as number, svb[1] as number, svb[2] as number, svb[3] as number],
            elements: validatedSymbolElements,
          });
        }
      }

      definitions = {
        ...(gradientDefs.length > 0 ? { gradients: gradientDefs } : {}),
        ...(symbolDefs.length > 0 ? { symbols: symbolDefs } : {}),
      };
    }

    // 4. Validate root elements
    const rawElements = root["elements"];
    if (!Array.isArray(rawElements) || rawElements.length === 0) {
      fail(ctx, "SCENE_INVALID_ELEMENTS", "Scene elements must be a non-empty array.", "$.elements");
    }

    const elements = rawElements.map((el, idx) =>
      validateElement(el, ctx, `$.elements[${idx}]`, 1, state, tokenBindings, definedGradients),
    );

    // 5. Post-expansion accounting, symbol cycle detection, and ceiling enforcement
    const symbolCosts = computeSymbolCosts(symbolDefs, ctx);

    const symbolsById = new Map<string, SymbolDef>();
    for (const s of symbolDefs) {
      symbolsById.set(s.id, s);
    }

    let expandedElementCount = 0;
    let totalGlyphs = 0;
    let totalPathSegments = 0;

    const usedSymbols = new Set<string>();

    function walkRoot(el: SceneElement, loc: string): void {
      expandedElementCount += loweredElementCost(el);
      if (expandedElementCount > SCENE_LIMITS.maxExpandedElements) {
        fail(
          ctx,
          "SCENE_LIMIT_EXCEEDED",
          `Expanded element count ${expandedElementCount} exceeds maximum allowed (${SCENE_LIMITS.maxExpandedElements}).`,
          loc,
        );
      }

      switch (el.type) {
        case "path":
          totalPathSegments += countPathSegments(el.d);
          break;
        case "rect":
        case "circle":
        case "ellipse":
          totalPathSegments += 4;
          break;
        case "line":
          totalPathSegments += 1;
          break;
        case "polyline":
          totalPathSegments += Math.max(1, el.points.length - 1);
          break;
        case "polygon":
          totalPathSegments += el.points.length;
          break;
        case "label": {
          const g = countLabelGlyphs(el.text);
          totalGlyphs += g;
          totalPathSegments += countTextPathSegments(el.text);
          break;
        }
        case "diagramNode": {
          totalPathSegments += 4;
          if (el.label !== undefined && el.label.trim() !== "") {
            const g = countLabelGlyphs(el.label);
            totalGlyphs += g;
            totalPathSegments += countTextPathSegments(el.label);
          }
          break;
        }
        case "connector": {
          let segs = el.routing === "orthogonal" ? 3 : 1;
          if (el.waypoints && el.waypoints.length > 0) segs = el.waypoints.length + 1;
          if (el.startArrowhead && el.startArrowhead !== "none") segs += 3;
          if (el.endArrowhead && el.endArrowhead !== "none") segs += 3;
          totalPathSegments += segs;
          break;
        }
        case "group":
          for (let i = 0; i < el.children.length; i += 1) {
            walkRoot(el.children[i]!, `${loc}.children[${i}]`);
          }
          break;
        case "use": {
          const ref = el.href.startsWith("#") ? el.href.slice(1) : el.href;
          const cost = symbolCosts.get(ref);
          if (!cost) {
            fail(
              ctx,
              "SCENE_INVALID_USE_REFERENCE",
              `use references unknown symbol '${ref}'. Use only local symbols.`,
              loc,
            );
          }
          usedSymbols.add(ref);
          expandedElementCount += cost.elements;
          totalGlyphs += cost.glyphs;
          totalPathSegments += cost.pathSegments;
          break;
        }
      }

      if (totalGlyphs > SCENE_LIMITS.maxGlyphsPerScene) {
        fail(
          ctx,
          "SCENE_LIMIT_EXCEEDED",
          `Total scene glyph count ${totalGlyphs} exceeds maximum allowed (${SCENE_LIMITS.maxGlyphsPerScene}).`,
          loc,
        );
      }
      if (expandedElementCount > SCENE_LIMITS.maxExpandedElements) {
        fail(
          ctx,
          "SCENE_LIMIT_EXCEEDED",
          `Expanded element count ${expandedElementCount} exceeds maximum allowed (${SCENE_LIMITS.maxExpandedElements}).`,
          loc,
        );
      }
      if (totalPathSegments > SCENE_LIMITS.maxAggregatePathSegments) {
        fail(
          ctx,
          "SCENE_LIMIT_EXCEEDED",
          `Total path segment count ${totalPathSegments} exceeds maximum allowed (${SCENE_LIMITS.maxAggregatePathSegments}).`,
          loc,
        );
      }
    }

    for (let i = 0; i < elements.length; i += 1) {
      walkRoot(elements[i]!, `$.elements[${i}]`);
    }

    // Transitively mark symbols used by other used symbols
    const queue = Array.from(usedSymbols);
    while (queue.length > 0) {
      const currId = queue.shift()!;
      const sym = symbolsById.get(currId);
      if (sym) {
        function findUses(el: SceneElement): void {
          if (el.type === "use") {
            const r = el.href.startsWith("#") ? el.href.slice(1) : el.href;
            if (!usedSymbols.has(r)) {
              usedSymbols.add(r);
              queue.push(r);
            }
          } else if (el.type === "group") {
            for (const c of el.children) findUses(c);
          }
        }
        for (const el of sym.elements) findUses(el);
      }
    }

    // Account unused definitions resource consumption
    for (const s of symbolDefs) {
      if (!usedSymbols.has(s.id)) {
        const cost = symbolCosts.get(s.id)!;
        expandedElementCount += cost.elements;
        totalGlyphs += cost.glyphs;
        totalPathSegments += cost.pathSegments;
      }
    }

    if (totalGlyphs > SCENE_LIMITS.maxGlyphsPerScene) {
      fail(
        ctx,
        "SCENE_LIMIT_EXCEEDED",
        `Total scene glyph count ${totalGlyphs} exceeds maximum allowed (${SCENE_LIMITS.maxGlyphsPerScene}).`,
        "$.definitions.symbols",
      );
    }
    if (expandedElementCount > SCENE_LIMITS.maxExpandedElements) {
      fail(
        ctx,
        "SCENE_LIMIT_EXCEEDED",
        `Expanded element count ${expandedElementCount} exceeds maximum allowed (${SCENE_LIMITS.maxExpandedElements}).`,
        "$.definitions.symbols",
      );
    }
    if (totalPathSegments > SCENE_LIMITS.maxAggregatePathSegments) {
      fail(
        ctx,
        "SCENE_LIMIT_EXCEEDED",
        `Total path segment count ${totalPathSegments} exceeds maximum allowed (${SCENE_LIMITS.maxAggregatePathSegments}).`,
        "$.definitions.symbols",
      );
    }

    // 6. Validate element map and connector targets
    function registerElementMap(
      items: readonly SceneElement[],
      targetMap: Map<string, SceneElement>,
    ): void {
      for (const item of items) {
        if (item.id !== undefined) {
          targetMap.set(item.id, item);
        }
        if (item.type === "group") {
          registerElementMap(item.children, targetMap);
        }
      }
    }

    function checkConnectors(
      items: readonly SceneElement[],
      loc: string,
    ): void {
      // Lowering resolves anchors in each sibling coordinate space. A global
      // scene/symbol map would accept cross-group references it cannot lower.
      const targetMap = new Map(items.flatMap((item) => item.id === undefined ? [] : [[item.id, item] as const]));
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]!;
        const itemLoc = `${loc}[${i}]`;
        if (item.type === "connector") {
          if ("elementId" in item.from) {
            const targetEl = targetMap.get(item.from.elementId);
            if (!targetEl) {
              fail(
                ctx,
                "SCENE_MISSING_ANCHOR_TARGET",
                `Connector endpoint references unknown element or anchor target '${item.from.elementId}'.`,
                `${itemLoc}.from`,
              );
            }
            if (computeElementBounds(targetEl, symbolsById) === undefined) {
              fail(
                ctx,
                "SCENE_MISSING_ANCHOR_TARGET",
                `Connector endpoint references element '${item.from.elementId}' with indeterminable bounds.`,
                `${itemLoc}.from`,
              );
            }
          }
          if ("elementId" in item.to) {
            const targetEl = targetMap.get(item.to.elementId);
            if (!targetEl) {
              fail(
                ctx,
                "SCENE_MISSING_ANCHOR_TARGET",
                `Connector endpoint references unknown element or anchor target '${item.to.elementId}'.`,
                `${itemLoc}.to`,
              );
            }
            if (computeElementBounds(targetEl, symbolsById) === undefined) {
              fail(
                ctx,
                "SCENE_MISSING_ANCHOR_TARGET",
                `Connector endpoint references element '${item.to.elementId}' with indeterminable bounds.`,
                `${itemLoc}.to`,
              );
            }
          }
        } else if (item.type === "group") {
          checkConnectors(item.children, `${itemLoc}.children`);
        }
      }
    }

    const elementMap = new Map<string, SceneElement>();
    registerElementMap(elements, elementMap);
    checkConnectors(elements, "$.elements");

    for (let sIdx = 0; sIdx < symbolDefs.length; sIdx += 1) {
      const sym = symbolDefs[sIdx]!;
      checkConnectors(
        sym.elements,
        `$.definitions.symbols[${sIdx}].elements`,
      );
    }

    // 7. Validate layout directives and feasibility
    let layoutDirectives: LayoutDirective[] | undefined;
    if (root["layout"] !== undefined) {
      layoutDirectives = validateLayoutDirectives(root["layout"], ctx, "$.layout");

      for (let i = 0; i < layoutDirectives.length; i += 1) {
        const dir = layoutDirectives[i]!;
        const dirLoc = `$.layout[${i}]`;
        switch (dir.type) {
          case "align":
          case "distribute":
          case "grid": {
            for (const t of dir.targets) {
              if (!elementMap.has(t)) {
                fail(
                  ctx,
                  "SCENE_MISSING_LAYOUT_TARGET",
                  `Layout directive references unknown element '${t}'.`,
                  dirLoc,
                );
              }
            }
            if (dir.type === "align" && dir.relativeTo !== undefined) {
              if (!elementMap.has(dir.relativeTo)) {
                fail(
                  ctx,
                  "SCENE_MISSING_LAYOUT_TARGET",
                  `Layout directive references unknown element '${dir.relativeTo}'.`,
                  dirLoc,
                );
              }
            }
            break;
          }
          case "anchor": {
            if (!elementMap.has(dir.target)) {
              fail(
                ctx,
                "SCENE_MISSING_LAYOUT_TARGET",
                `Layout directive references unknown element '${dir.target}'.`,
                dirLoc,
              );
            }
            if (!elementMap.has(dir.relativeTo)) {
              fail(
                ctx,
                "SCENE_MISSING_LAYOUT_TARGET",
                `Layout directive references unknown element '${dir.relativeTo}'.`,
                dirLoc,
              );
            }
            break;
          }
        }
      }

      // Check layout cycle detection, self-anchoring, and bounds feasibility
      lowerLayout(elements, layoutDirectives, symbolsById, ctx, "$.layout");
    }

    // 8. Validate provenance
    let provenance: SceneProvenance | undefined;
    if (root["provenance"] !== undefined) {
      provenance = validateProvenance(root["provenance"], ctx, "$.provenance");
    }

    const scene: VectorScene = {
      schema: SCENE_SCHEMA,
      compatibility: SCENE_COMPATIBILITY,
      compilerLevel: requiredCompilerLevel as VectorScene["compilerLevel"],
      profile: profile as SceneProfile,
      artboard,
      accessibility,
      elements,
      ...(definitions !== undefined ? { definitions } : {}),
      ...(tokenBindings !== undefined ? { tokenBindings } : {}),
      ...(layoutDirectives !== undefined ? { layout: layoutDirectives } : {}),
      ...(provenance !== undefined ? { provenance } : {}),
    };

    const metrics: SceneMetrics = {
      expandedElementCount,
      authoredElementCount: state.authoredElementCount,
      pathSegmentCount: totalPathSegments,
      glyphCount: totalGlyphs,
      maxNestingDepth: state.maxDepth,
      gradientStopCount,
    };

    return { ok: true, value: { scene, metrics } };
  } catch (error) {
    if (error instanceof DiagnosticError) {
      return { ok: false, diagnostics: [error.diagnostic] };
    }
    return { ok: false, diagnostics: [{ code: "SCENE_INVALID_GEOMETRY", operation: "validate", domain: "scene", message: "Scene geometry could not be validated within production limits." }] };
  }
}
