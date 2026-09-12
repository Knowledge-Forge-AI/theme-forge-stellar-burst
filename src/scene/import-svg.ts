import {
  DOMParser,
  MIME_TYPE,
  onWarningStopParsing,
  type Document,
  type Element,
  type Node,
} from "@xmldom/xmldom";

import { computeSha256 } from "../digests.js";
import {
  isLocalId,
  parseHexColor,
  parsePathData,
} from "../primitives.js";
import {
  SCENE_COMPATIBILITY,
  SCENE_COMPILER_LEVEL,
  SCENE_LIMITS,
  SCENE_SCHEMA,
} from "./constants.js";
import { canonicalizeScene, compileScene } from "./compile.js";
import {
  ALLOWED_GEOMETRY,
  ALLOWED_PRESENTATION,
  ARTWORK_TAGS,
  MAX_INPUT_BYTES,
  MAX_XML_DEPTH,
  MAX_XML_NODES,
  MAX_AGGREGATE_ATTRIBUTES,
  MAX_PER_ELEMENT_ATTRIBUTES,
  guardSvgXml,
  inspectImportSemantics,
  type ImportFindings,
} from "./import-svg-guard.js";
import { validateScene } from "./validate.js";
import type { DiagnosticContext } from "../diagnostics.js";
import type { HexColor } from "../types.js";
import type {
  CircleElement,
  EllipseElement,
  GradientStop,
  GroupElement,
  LineElement,
  LinearGradientDef,
  Paint,
  PathElement,
  PolygonElement,
  PolylineElement,
  Presentation,
  RadialGradientDef,
  RectElement,
  SceneAccessibility,
  SceneDefinitions,
  SceneElement,
  SymbolDef,
  TransformOperation,
  UseElement,
  VectorScene,
} from "./types.js";
import type {
  SceneImportClassification,
  SceneImportFeatures,
  SceneImportResult,
} from "./import-svg-types.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

const ELEMENT_NODE = 1;

const ACTIVE_TAGS = new Set([
  "script",
  "foreignObject",
  "animate",
  "animateMotion",
  "animateTransform",
  "animateColor",
  "set",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
]);

const DEFERRED_TAGS = new Set([
  "text",
  "tspan",
  "textPath",
  "clipPath",
  "mask",
]);

const OUT_OF_SCOPE_TAGS = new Set([
  "filter",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feOffset",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feImage",
  "feMorphology",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "image",
  "marker",
  "pattern",
]);

const SUPPORTED_TAGS = new Set([
  "svg",
  "defs",
  "symbol",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "use",
  "linearGradient",
  "radialGradient",
  "stop",
  "title",
  "desc",
  "metadata",
]);

const KNOWN_COLOR_NAMES: Readonly<Record<string, HexColor>> = Object.freeze({
  black: "#000000" as HexColor,
  white: "#FFFFFF" as HexColor,
  red: "#FF0000" as HexColor,
  green: "#008000" as HexColor,
  blue: "#0000FF" as HexColor,
  yellow: "#FFFF00" as HexColor,
  cyan: "#00FFFF" as HexColor,
  magenta: "#FF00FF" as HexColor,
  gray: "#808080" as HexColor,
  grey: "#808080" as HexColor,
  silver: "#C0C0C0" as HexColor,
  maroon: "#800000" as HexColor,
  olive: "#808000" as HexColor,
  purple: "#800080" as HexColor,
  teal: "#008080" as HexColor,
  navy: "#000080" as HexColor,
  orange: "#FFA500" as HexColor,
});

interface PreflightResult {
  readonly ok: boolean;
  readonly classification?: SceneImportClassification;
  readonly reasonCode?: string;
}

/**
 * Quote- and comment-aware preflight scanner before DOM parser.
 */
function preflightScan(text: string): PreflightResult {
  let pos = 0;
  const len = text.length;
  let seenXmlDecl = false;

  while (pos < len) {
    const nextLt = text.indexOf("<", pos);
    if (nextLt === -1) break;

    // Check for comment
    if (text.startsWith("<!--", nextLt)) {
      const endComment = text.indexOf("-->", nextLt + 4);
      if (endComment === -1) {
        return { ok: false, classification: "INVALID_INPUT", reasonCode: "XML_SYNTAX_ERROR" };
      }
      pos = endComment + 3;
      continue;
    }

    // Check for processing instruction
    if (text.startsWith("<?", nextLt)) {
      const endPi = text.indexOf("?>", nextLt + 2);
      if (endPi === -1) {
        return { ok: false, classification: "INVALID_INPUT", reasonCode: "XML_SYNTAX_ERROR" };
      }
      const piContent = text.slice(nextLt, endPi + 2);
      if (/^<\?xml-stylesheet\b/i.test(piContent)) {
        return { ok: false, classification: "REJECTED_UNSAFE", reasonCode: "UNSAFE_PROCESSING_INSTRUCTION" };
      }
      const leadingPrefix = text.slice(0, nextLt).replace(/^\uFEFF/, "");
      const isXmlDeclaration = /^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])UTF-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>$/i.test(piContent);
      if (seenXmlDecl || leadingPrefix.trim() !== "" || !isXmlDeclaration) {
        return { ok: false, classification: "REJECTED_UNSAFE", reasonCode: "UNSAFE_PROCESSING_INSTRUCTION" };
      }
      seenXmlDecl = true;
      pos = endPi + 2;
      continue;
    }

    // Check for <! declarations
    if (text.startsWith("<!", nextLt)) {
      // Bounded lookahead avoids rescanning/copying each remaining input tail.
      const declaration = text.slice(nextLt, nextLt + 10);
      if (/^<!DOCTYPE\b/i.test(declaration)) {
        return { ok: false, classification: "REJECTED_UNSAFE", reasonCode: "UNSAFE_DTD" };
      }
      if (/^<!ENTITY\b/i.test(declaration)) {
        return { ok: false, classification: "REJECTED_UNSAFE", reasonCode: "UNSAFE_ENTITY" };
      }
      if (/^<!\[CDATA\[/i.test(declaration)) {
        const endCdata = text.indexOf("]]>", nextLt + 9);
        if (endCdata === -1) {
          return { ok: false, classification: "INVALID_INPUT", reasonCode: "XML_SYNTAX_ERROR" };
        }
        pos = endCdata + 3;
        continue;
      }
      return { ok: false, classification: "REJECTED_UNSAFE", reasonCode: "UNSAFE_DECLARATION" };
    }

    // Advance past this '<'
    pos = nextLt + 1;
  }

  return { ok: true };
}

/**
 * Check if an href or reference is external.
 */
function isExternalHref(value: string): boolean {
  const target = value.trim().replace(/^['"]|['"]$/g, "").trim();
  if (!target.startsWith("#") || target.includes(" ")) {
    return true;
  }
  return false;
}

/**
 * Check if any url(...) in value references an external resource.
 */
function hasExternalUrl(value: string): boolean {
  for (const match of value.matchAll(/url\s*\(\s*([^)]+)\s*\)/gi)) {
    const target = (match[1] ?? "").trim().replace(/^['"]|['"]$/g, "").trim();
    if (!target.startsWith("#") || target.includes(" ")) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a path string has packed arc flags that hit strict parser limits.
 */
function hasPackedArcFlags(d: string): boolean {
  return /[Aa][^A-Za-z]+[01]{2}/.test(d);
}

/**
 * Parse and normalize a color string into HexColor.
 */
function parseAndNormalizeColor(
  raw: string,
  normalizations: Set<string>,
): { readonly color?: HexColor; readonly unsupported?: boolean } {
  const trimmed = raw.trim();

  // 3-digit hex: #rgb
  if (/^#[0-9A-Fa-f]{3}$/.test(trimmed)) {
    const r = trimmed[1]!;
    const g = trimmed[2]!;
    const b = trimmed[3]!;
    normalizations.add("expand_hex_color");
    return { color: `#${r}${r}${g}${g}${b}${b}`.toUpperCase() as HexColor };
  }

  // 6-digit hex: #rrggbb
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) {
    const upper = trimmed.toUpperCase() as HexColor;
    if (upper !== trimmed) {
      normalizations.add("normalize_hex_case");
    }
    return { color: upper };
  }

  // 4-digit hex with alpha: #rgba (exact alpha only if alpha is F)
  if (/^#[0-9A-Fa-f]{4}$/.test(trimmed)) {
    const a = trimmed[4]!.toUpperCase();
    if (a === "F") {
      const r = trimmed[1]!;
      const g = trimmed[2]!;
      const b = trimmed[3]!;
      normalizations.add("expand_hex_color");
      return { color: `#${r}${r}${g}${g}${b}${b}`.toUpperCase() as HexColor };
    }
    return { unsupported: true };
  }

  // 8-digit hex with alpha: #rrggbbaa (exact alpha only if alpha is FF)
  if (/^#[0-9A-Fa-f]{8}$/.test(trimmed)) {
    const aa = trimmed.slice(7).toUpperCase();
    if (aa === "FF") {
      normalizations.add("normalize_hex_case");
      return { color: trimmed.slice(0, 7).toUpperCase() as HexColor };
    }
    return { unsupported: true };
  }

  // Known bounded color names
  const lower = trimmed.toLowerCase();
  if (Object.hasOwn(KNOWN_COLOR_NAMES, lower)) {
    normalizations.add("color_name_to_hex");
    return { color: KNOWN_COLOR_NAMES[lower]! };
  }

  // rgb(r, g, b)
  const rgbMatch = /^rgb\(\s*(\d+%?)\s*[, \t\r\n]+\s*(\d+%?)\s*[, \t\r\n]+\s*(\d+%?)\s*\)$/i.exec(trimmed);
  if (rgbMatch) {
    const parseComponent = (c: string): number => {
      if (c.endsWith("%")) {
        return Math.round((Math.min(100, Math.max(0, parseFloat(c))) / 100) * 255);
      }
      return Math.min(255, Math.max(0, parseInt(c, 10)));
    };
    const r = parseComponent(rgbMatch[1]!).toString(16).padStart(2, "0");
    const g = parseComponent(rgbMatch[2]!).toString(16).padStart(2, "0");
    const b = parseComponent(rgbMatch[3]!).toString(16).padStart(2, "0");
    normalizations.add("color_rgb_to_hex");
    return { color: `#${r}${g}${b}`.toUpperCase() as HexColor };
  }

  // rgba(r, g, b, 1) exact alpha
  const rgbaMatch = /^rgba\(\s*(\d+%?)\s*[, \t\r\n]+\s*(\d+%?)\s*[, \t\r\n]+\s*(\d+%?)\s*[, \t\r\n]+\s*(1(?:\.0+)?|100%)\s*\)$/i.exec(trimmed);
  if (rgbaMatch) {
    const parseComponent = (c: string): number => {
      if (c.endsWith("%")) {
        return Math.round((Math.min(100, Math.max(0, parseFloat(c))) / 100) * 255);
      }
      return Math.min(255, Math.max(0, parseInt(c, 10)));
    };
    const r = parseComponent(rgbaMatch[1]!).toString(16).padStart(2, "0");
    const g = parseComponent(rgbaMatch[2]!).toString(16).padStart(2, "0");
    const b = parseComponent(rgbaMatch[3]!).toString(16).padStart(2, "0");
    normalizations.add("color_rgb_to_hex");
    return { color: `#${r}${g}${b}`.toUpperCase() as HexColor };
  }

  return { unsupported: true };
}

/**
 * Parse paint value into Paint.
 */
function parsePaint(
  value: string,
  normalizations: Set<string>,
  patterns: Set<string>,
  outOfScopeReasons: Set<string>,
): Paint | undefined {
  const trimmed = value.trim();
  if (trimmed === "none") {
    patterns.add("paint.none");
    return { type: "none" };
  }
  if (trimmed === "currentColor") {
    patterns.add("paint.currentColor");
    return { type: "currentColor" };
  }
  if (trimmed.toLowerCase() === "transparent") {
    patterns.add("paint.none");
    normalizations.add("color_name_to_hex");
    return { type: "none" };
  }

  const gradMatch = /^url\(#([^)]+)\)(?:[\t\n\r ]+(#[0-9A-Fa-f]{6}))?$/.exec(trimmed);
  if (gradMatch !== null) {
    patterns.add("reference.local");
    patterns.add("paint.gradientReference");
    return {
      type: "gradient",
      id: gradMatch[1]!,
      ...(gradMatch[2] !== undefined ? { fallback: gradMatch[2].toUpperCase() as HexColor } : {}),
    };
  }

  const colorRes = parseAndNormalizeColor(trimmed, normalizations);
  if (colorRes.color !== undefined) {
    patterns.add("paint.hex");
    return { type: "solid", color: colorRes.color };
  }

  if (colorRes.unsupported) {
    outOfScopeReasons.add("COLOR_UNSUPPORTED");
  }

  return undefined;
}

/**
 * Parse gradient coordinates which accept unitless or percentage.
 */
function parseGradientCoordinate(
  value: string,
  defaultValue: number,
  normalizations: Set<string>,
  outOfScopeReasons: Set<string>,
): number {
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    const num = Number(trimmed.slice(0, -1));
    if (Number.isFinite(num)) {
      normalizations.add("gradient_percentage_to_number");
      return num / 100;
    }
  }
  const parsed = parseLength(trimmed, normalizations, outOfScopeReasons);
  return parsed ?? defaultValue;
}

/**
 * Strip unit 'px' or detect unsupported units.
 */
function parseLength(
  value: string,
  normalizations: Set<string>,
  outOfScopeReasons: Set<string>,
): number | undefined {
  const trimmed = value.trim();
  if (/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?px$/i.test(trimmed)) {
    normalizations.add("unit_px_to_unitless");
    const num = Number(trimmed.slice(0, -2));
    return Number.isFinite(num) ? num : undefined;
  }
  if (/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : undefined;
  }
  if (/[%a-z]+/i.test(trimmed)) {
    outOfScopeReasons.add("OUT_OF_SCOPE_UNITS");
  }
  return undefined;
}

/**
 * Parse transforms string into TransformOperation array.
 */
function parseTransforms(
  value: string,
  normalizations: Set<string>,
  patterns: Set<string>,
  outOfScopeReasons: Set<string>,
  invalidReasons: Set<string>,
): readonly TransformOperation[] | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  let rest = trimmed;
  const num = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
  const opPattern = new RegExp(
    `^(translate|scale|rotate|matrix|skewX|skewY)\\(\\s*(${num})(?:[\\t\\n\\r ,]+(${num}))?(?:[\\t\\n\\r ,]+(${num}))?(?:[\\t\\n\\r ,]+(${num}))?(?:[\\t\\n\\r ,]+(${num}))?(?:[\\t\\n\\r ,]+(${num}))?\\s*\\)`,
  );

  const ops: TransformOperation[] = [];

  while (rest.length > 0) {
    const match = opPattern.exec(rest);
    if (match === null) {
      invalidReasons.add("INVALID_TRANSFORM");
      return undefined;
    }

    const opName = match[1]!;
    patterns.add(`transform.${opName}`);

    if (opName === "skewX" || opName === "skewY") {
      outOfScopeReasons.add("OUT_OF_SCOPE_TRANSFORM");
      return undefined;
    }

    const args = match
      .slice(2)
      .filter((item): item is string => item !== undefined && item !== "")
      .map((item) => Number(item));

    if (args.some((arg) => !Number.isFinite(arg))) {
      invalidReasons.add("INVALID_TRANSFORM");
      return undefined;
    }

    if (opName === "translate") {
      if (args.length < 1 || args.length > 2) {
        invalidReasons.add("INVALID_TRANSFORM");
        return undefined;
      }
      ops.push({
        type: "translate",
        x: args[0]!,
        ...(args.length === 2 && args[1] !== 0 ? { y: args[1] } : {}),
      });
    } else if (opName === "scale") {
      if (args.length < 1 || args.length > 2) {
        invalidReasons.add("INVALID_TRANSFORM");
        return undefined;
      }
      ops.push({
        type: "scale",
        x: args[0]!,
        ...(args.length === 2 && args[1] !== args[0] ? { y: args[1] } : {}),
      });
    } else if (opName === "rotate") {
      if (args.length !== 1 && args.length !== 3) {
        invalidReasons.add("INVALID_TRANSFORM");
        return undefined;
      }
      ops.push({
        type: "rotate",
        angle: args[0]!,
        ...(args.length === 3 ? { cx: args[1]!, cy: args[2]! } : {}),
      });
    } else if (opName === "matrix") {
      if (args.length !== 6) {
        invalidReasons.add("INVALID_TRANSFORM");
        return undefined;
      }
      ops.push({
        type: "matrix",
        a: args[0]!,
        b: args[1]!,
        c: args[2]!,
        d: args[3]!,
        e: args[4]!,
        f: args[5]!,
      });
    }

    rest = rest.slice(match[0].length).trim();
    if (rest.startsWith(",")) {
      rest = rest.slice(1).trim();
    }
  }

  if (ops.length > SCENE_LIMITS.maxTransforms) {
    outOfScopeReasons.add("LIMIT_TRANSFORMS_EXCEEDED");
  }

  return ops;
}

/**
 * Extract presentation attributes from an Element.
 */
function extractPresentation(
  element: Element,
  normalizations: Set<string>,
  patterns: Set<string>,
  outOfScopeReasons: Set<string>,
): Presentation {
  const result: { [key: string]: unknown } = {};

  const fillAttr = element.getAttribute("fill");
  if (fillAttr !== null) {
    const fill = parsePaint(fillAttr, normalizations, patterns, outOfScopeReasons);
    if (fill !== undefined) result["fill"] = fill;
  }

  const strokeAttr = element.getAttribute("stroke");
  if (strokeAttr !== null) {
    const stroke = parsePaint(strokeAttr, normalizations, patterns, outOfScopeReasons);
    if (stroke !== undefined) result["stroke"] = stroke;
  }

  const swAttr = element.getAttribute("stroke-width");
  if (swAttr !== null) {
    const sw = parseLength(swAttr, normalizations, outOfScopeReasons);
    if (sw !== undefined && sw >= 0) result["strokeWidth"] = sw;
  }

  const capAttr = element.getAttribute("stroke-linecap");
  if (capAttr !== null && ["butt", "round", "square"].includes(capAttr)) {
    result["strokeLinecap"] = capAttr;
  }

  const joinAttr = element.getAttribute("stroke-linejoin");
  if (joinAttr !== null && ["miter", "round", "bevel"].includes(joinAttr)) {
    result["strokeLinejoin"] = joinAttr;
  }

  const mlAttr = element.getAttribute("stroke-miterlimit");
  if (mlAttr !== null) {
    const ml = parseLength(mlAttr, normalizations, outOfScopeReasons);
    if (ml !== undefined && ml >= 1) result["strokeMiterlimit"] = ml;
  }

  const daAttr = element.getAttribute("stroke-dasharray");
  if (daAttr !== null && daAttr !== "none") {
    const tokens = daAttr.split(/[\t\n\r ,]+/).filter(Boolean);
    const nums = tokens.map((t) => parseLength(t, normalizations, outOfScopeReasons));
    if (nums.every((n): n is number => n !== undefined && n >= 0)) {
      result["strokeDasharray"] = nums;
    }
  }

  const doAttr = element.getAttribute("stroke-dashoffset");
  if (doAttr !== null) {
    const sdo = parseLength(doAttr, normalizations, outOfScopeReasons);
    if (sdo !== undefined) result["strokeDashoffset"] = sdo;
  }

  const opAttr = element.getAttribute("opacity");
  if (opAttr !== null) {
    const op = parseFloat(opAttr);
    if (Number.isFinite(op) && op >= 0 && op <= 1) result["opacity"] = op;
  }

  const fopAttr = element.getAttribute("fill-opacity");
  if (fopAttr !== null) {
    const fop = parseFloat(fopAttr);
    if (Number.isFinite(fop) && fop >= 0 && fop <= 1) result["fillOpacity"] = fop;
  }

  const sopAttr = element.getAttribute("stroke-opacity");
  if (sopAttr !== null) {
    const sop = parseFloat(sopAttr);
    if (Number.isFinite(sop) && sop >= 0 && sop <= 1) result["strokeOpacity"] = sop;
  }

  const frAttr = element.getAttribute("fill-rule");
  if (frAttr !== null && ["nonzero", "evenodd"].includes(frAttr)) {
    result["fillRule"] = frAttr;
  }

  const crAttr = element.getAttribute("clip-rule");
  if (crAttr !== null && ["nonzero", "evenodd"].includes(crAttr)) {
    result["clipRule"] = crAttr;
  }

  const ariaAttr = element.getAttribute("aria-hidden");
  if (ariaAttr !== null) {
    result["ariaHidden"] = ariaAttr === "true";
  }

  return result as Presentation;
}

/**
 * Public API to import an SVG byte buffer into the safe vector scene domain.
 */
export function sceneImportSvg(input: Uint8Array): SceneImportResult {
  const sourceSha256 = computeSha256(input);
  const normalizations = new Set<string>();
  const observedTags = new Set<string>();
  const observedAttributes = new Set<string>();
  const observedPatterns = new Set<string>();

  const unsafeReasons = new Set<string>();
  const analyzeOnlyReasons = new Set<string>();
  const deferredReasons = new Set<string>();
  const outOfScopeReasons = new Set<string>();
  const invalidReasons = new Set<string>();

  // 1. Check size limit before decoding
  if (input.byteLength > MAX_INPUT_BYTES) {
    return {
      classification: "REJECTED_OUT_OF_SCOPE",
      reasonCodes: ["LIMIT_INPUT_SIZE_EXCEEDED"],
      features: { tags: [], attributes: [], patterns: [], complete: false },
      normalizations: [],
      sourceSha256,
    };
  }

  // 2. Decode UTF-8 with fatal error checking
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return {
      classification: "INVALID_INPUT",
      reasonCodes: ["INVALID_UTF8"],
      features: { tags: [], attributes: [], patterns: [], complete: false },
      normalizations: [],
      sourceSha256,
    };
  }

  // 3. Preflight scan (quote- and comment-aware)
  const preflight = preflightScan(text);
  if (!preflight.ok) {
    return {
      classification: preflight.classification ?? "INVALID_INPUT",
      reasonCodes: [preflight.reasonCode ?? "XML_SYNTAX_ERROR"],
      features: { tags: [], attributes: [], patterns: [], complete: false },
      normalizations: [],
      sourceSha256,
    };
  }

  // 3.5 XML structural limits guard
  const guardLimit = guardSvgXml(text);
  if (guardLimit !== undefined) {
    return {
      classification: "REJECTED_OUT_OF_SCOPE",
      reasonCodes: [guardLimit],
      features: { tags: [], attributes: [], patterns: [], complete: false },
      normalizations: [],
      sourceSha256,
    };
  }

  // 4. Parse XML with xmldom
  let document: Document;
  try {
    const normalizedText = text.replace(/^\uFEFF/, "");
    document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(
      normalizedText,
      MIME_TYPE.XML_APPLICATION,
    );
  } catch {
    return {
      classification: "INVALID_INPUT",
      reasonCodes: ["XML_SYNTAX_ERROR"],
      features: { tags: [], attributes: [], patterns: [], complete: false },
      normalizations: [],
      sourceSha256,
    };
  }

  // 5. Inspect entire DOM tree (including unused defs)
  const root = document.documentElement;
  if (!root || root.localName !== "svg") {
    return {
      classification: "INVALID_INPUT",
      reasonCodes: ["INVALID_ROOT_ELEMENT"],
      features: { tags: root ? [root.localName ?? root.nodeName] : [], attributes: [], patterns: [], complete: true },
      normalizations: [],
      sourceSha256,
    };
  }

  const semanticFindings: ImportFindings = {
    unsafe: new Set<string>(),
    unsupported: new Set<string>(),
    invalid: new Set<string>(),
    limits: new Set<string>(),
    patterns: new Set<string>(),
  };
  inspectImportSemantics(root, semanticFindings);

  for (const code of semanticFindings.unsafe) unsafeReasons.add(code);
  for (const code of semanticFindings.invalid) invalidReasons.add(code);
  for (const code of semanticFindings.limits) outOfScopeReasons.add(code);
  for (const pattern of semanticFindings.patterns) observedPatterns.add(pattern);
  for (const code of semanticFindings.unsupported) {
    if (code === "UNSUPPORTED_METADATA_MARKUP") {
      analyzeOnlyReasons.add(code);
    } else if (code === "UNSUPPORTED_NAMESPACE") {
      let hasNonMetaNonSvg = false;
      const allEls = [root, ...Array.from(root.getElementsByTagName("*"))];
      for (const el of allEls) {
        if (el.namespaceURI !== "http://www.w3.org/2000/svg") {
          let inMeta = el.localName === "metadata";
          let p: Node | null = el.parentNode;
          while (p && !inMeta) {
            if (p.nodeType === ELEMENT_NODE && (p as Element).localName === "metadata") inMeta = true;
            p = p.parentNode;
          }
          if (!inMeta) {
            hasNonMetaNonSvg = true;
            break;
          }
        }
      }
      if (hasNonMetaNonSvg) {
        outOfScopeReasons.add(code);
      } else {
        analyzeOnlyReasons.add("UNSUPPORTED_METADATA_MARKUP");
      }
    } else if (code === "UNSUPPORTED_TEXT_CONTENT") {
      let hasTextOutsideMeta = false;
      const allEls = [root, ...Array.from(root.getElementsByTagName("*"))];
      for (const el of allEls) {
        let inMeta = el.localName === "metadata";
        let p: Node | null = el.parentNode;
        while (p && !inMeta) {
          if (p.nodeType === ELEMENT_NODE && (p as Element).localName === "metadata") inMeta = true;
          p = p.parentNode;
        }
        if (!inMeta && !["title", "desc", "style", "text", "tspan", "metadata"].includes(el.localName ?? el.tagName)) {
          for (let i = 0; i < el.childNodes.length; i += 1) {
            const child = el.childNodes.item(i);
            if (child && (child.nodeType === 3 || child.nodeType === 4) && child.nodeValue?.trim()) {
              hasTextOutsideMeta = true;
              break;
            }
          }
        }
        if (hasTextOutsideMeta) break;
      }
      if (hasTextOutsideMeta) {
        outOfScopeReasons.add(code);
      } else {
        analyzeOnlyReasons.add("UNSUPPORTED_METADATA_MARKUP");
      }
    } else if (code === "UNSUPPORTED_LENGTH_VALUE") {
      outOfScopeReasons.add("UNSUPPORTED_LENGTH_VALUE");
      outOfScopeReasons.add("OUT_OF_SCOPE_UNITS");
    } else if (code === "UNSUPPORTED_ATTRIBUTE") {
      let hasAttrOutsideDeferred = false;
      const allEls = [root, ...Array.from(root.getElementsByTagName("*"))];
      for (const el of allEls) {
        let inDeferred = DEFERRED_TAGS.has(el.localName ?? el.tagName);
        let p: Node | null = el.parentNode;
        while (p && !inDeferred) {
          if (p.nodeType === ELEMENT_NODE && DEFERRED_TAGS.has((p as Element).localName ?? (p as Element).tagName)) inDeferred = true;
          p = p.parentNode;
        }
        if (!inDeferred) {
          const tag = el.localName ?? el.tagName;
          const allowed = new Set(["id", ...(ALLOWED_GEOMETRY[tag] ?? [])]);
          if (tag === "svg" || ARTWORK_TAGS.has(tag)) for (const a of ALLOWED_PRESENTATION) allowed.add(a);
          if (ARTWORK_TAGS.has(tag)) allowed.add("transform");
          for (const attr of Array.from(el.attributes)) {
            const name = attr.name;
            if (name === "xmlns" || name.startsWith("xmlns:")) continue;
            if (!allowed.has(name) && !["style", "class", "clip-path", "mask", "filter"].includes(name) && !/^on/i.test(name)) {
              hasAttrOutsideDeferred = true;
              break;
            }
          }
        }
        if (hasAttrOutsideDeferred) break;
      }
      if (hasAttrOutsideDeferred) {
        outOfScopeReasons.add(code);
      }
    } else {
      outOfScopeReasons.add(code);
    }
  }

  let featuresComplete = true;
  let totalNodes = 0;
  let aggregateAttributes = 0;
  let maxDepth = 0;
  let authoredElementCount = 0;

  // Map of definition IDs to their tag local names
  const defsMap = new Map<string, string>();
  const symbolMapPre = new Map<string, Element>();

  const defsElements = Array.from(root.getElementsByTagName("defs"));
  for (const defs of defsElements) {
    for (let i = 0; i < defs.childNodes.length; i += 1) {
      const child = defs.childNodes.item(i);
      if (child && child.nodeType === ELEMENT_NODE) {
        const cEl = child as Element;
        const cLocal = cEl.localName ?? cEl.tagName;
        const cId = cEl.getAttribute("id");
        if (cId) defsMap.set(cId, cLocal);
        if (cLocal === "symbol" && cId) symbolMapPre.set(cId, cEl);
      }
    }
  }

  function traverseNode(node: Node, depth: number): void {
    totalNodes += 1;
    if (depth > maxDepth) maxDepth = depth;

    if (depth > MAX_XML_DEPTH) {
      featuresComplete = false;
      outOfScopeReasons.add("LIMIT_XML_DEPTH_EXCEEDED");
      return;
    }
    if (totalNodes > MAX_XML_NODES) {
      featuresComplete = false;
      outOfScopeReasons.add("LIMIT_XML_NODES_EXCEEDED");
      return;
    }

    if (node.nodeType === ELEMENT_NODE) {
      const el = node as Element;
      const localName = el.localName ?? el.nodeName;
      observedTags.add(localName);
      observedPatterns.add(`element.${localName}`);

      if (ARTWORK_TAGS.has(localName)) {
        authoredElementCount += 1;
        if (authoredElementCount > SCENE_LIMITS.maxAuthoredElements) {
          outOfScopeReasons.add("LIMIT_AUTHORED_ELEMENTS_EXCEEDED");
        }
      }

      if (localName === "linearGradient" || localName === "radialGradient") {
        let stopCount = 0;
        for (let i = 0; i < el.childNodes.length; i += 1) {
          const child = el.childNodes.item(i);
          if (child && child.nodeType === ELEMENT_NODE && ((child as Element).localName ?? child.nodeName) === "stop") {
            stopCount += 1;
          }
        }
        if (stopCount > SCENE_LIMITS.maxGradientStops) {
          outOfScopeReasons.add("LIMIT_GRADIENT_STOPS_EXCEEDED");
        }
      }

      // Check element namespace
      if (el.namespaceURI && el.namespaceURI !== SVG_NAMESPACE) {
        let inMeta = localName === "metadata";
        let p: Node | null = el.parentNode;
        while (p && !inMeta) {
          if (p.nodeType === ELEMENT_NODE && (p as Element).localName === "metadata") {
            inMeta = true;
          }
          p = p.parentNode;
        }
        if (inMeta) {
          analyzeOnlyReasons.add("UNSUPPORTED_METADATA_MARKUP");
        } else {
          outOfScopeReasons.add("OUT_OF_SCOPE_NAMESPACE");
        }
      }

      // Check tag categories
      if (ACTIVE_TAGS.has(localName)) {
        if (localName === "script") unsafeReasons.add("UNSAFE_SCRIPT");
        else if (localName === "foreignObject") unsafeReasons.add("UNSAFE_FOREIGN_OBJECT");
        else if (localName.startsWith("animate") || localName === "set") unsafeReasons.add("UNSAFE_ANIMATION");
        else unsafeReasons.add("UNSAFE_ACTIVE_ELEMENT");
      } else if (DEFERRED_TAGS.has(localName)) {
        if (localName === "text" || localName === "tspan" || localName === "textPath") deferredReasons.add("DEFERRED_TEXT_ELEMENT");
        else if (localName === "clipPath") deferredReasons.add("DEFERRED_CLIP_PATH");
        else if (localName === "mask") deferredReasons.add("DEFERRED_MASK");
      } else if (OUT_OF_SCOPE_TAGS.has(localName)) {
        if (localName.startsWith("fe") || localName === "filter") outOfScopeReasons.add("OUT_OF_SCOPE_FILTER");
        else if (localName === "image") outOfScopeReasons.add("OUT_OF_SCOPE_IMAGE");
        else if (localName === "marker") outOfScopeReasons.add("OUT_OF_SCOPE_MARKER");
        else if (localName === "pattern") outOfScopeReasons.add("OUT_OF_SCOPE_PATTERN");
      } else if (localName === "style") {
        analyzeOnlyReasons.add("UNSUPPORTED_STYLE_ELEMENT");
      } else if (localName === "metadata") {
        // Inspect child elements of metadata: any non-text child is analyze-only
        for (let i = 0; i < el.childNodes.length; i += 1) {
          const child = el.childNodes.item(i);
          if (child && child.nodeType === ELEMENT_NODE) {
            analyzeOnlyReasons.add("UNSUPPORTED_METADATA_MARKUP");
            break;
          }
        }
      } else if (!SUPPORTED_TAGS.has(localName)) {
        let inMeta = false;
        let p: Node | null = el.parentNode;
        while (p && !inMeta) {
          if (p.nodeType === ELEMENT_NODE && (p as Element).localName === "metadata") {
            inMeta = true;
          }
          p = p.parentNode;
        }
        if (inMeta) {
          analyzeOnlyReasons.add("UNSUPPORTED_METADATA_MARKUP");
        } else {
          outOfScopeReasons.add("OUT_OF_SCOPE_UNKNOWN_TAG");
        }
      }

      // Check symbol has viewBox
      if (localName === "symbol") {
        const sVb = el.getAttribute("viewBox");
        if (!sVb || sVb.trim().split(/[\t\n\r ,]+/).filter(Boolean).length !== 4) {
          outOfScopeReasons.add("OUT_OF_SCOPE_SYMBOL_NO_VIEWBOX");
        }
      }

      // Check use references a symbol
      if (localName === "use") {
        const href = el.getAttribute("href") ?? el.getAttribute("xlink:href");
        if (href) {
          const refId = href.startsWith("#") ? href.slice(1) : href;
          if (defsMap.has(refId) && defsMap.get(refId) !== "symbol") {
            outOfScopeReasons.add("OUT_OF_SCOPE_USE_NON_SYMBOL");
          }
        }
      }

      // Nested SVG check
      if (localName === "svg" && depth > 1) {
        outOfScopeReasons.add("OUT_OF_SCOPE_NESTED_SVG");
      }

      // Check per-element attributes limit
      const attrCount = el.attributes.length;
      aggregateAttributes += attrCount;
      if (attrCount > MAX_PER_ELEMENT_ATTRIBUTES) {
        outOfScopeReasons.add("LIMIT_PER_ELEMENT_ATTRIBUTES_EXCEEDED");
      }
      if (aggregateAttributes > MAX_AGGREGATE_ATTRIBUTES) {
        outOfScopeReasons.add("LIMIT_AGGREGATE_ATTRIBUTES_EXCEEDED");
      }

      // Inspect each attribute
      for (let i = 0; i < attrCount; i += 1) {
        const attr = el.attributes.item(i);
        if (!attr) continue;
        const attrName = attr.name;
        const attrLocal = attr.localName ?? attrName;
        const attrVal = attr.value;
        observedAttributes.add(attrName);

        // Namespace check for attribute
        const isXmlns = attrName === "xmlns" || attrName.startsWith("xmlns:") || attr.namespaceURI === XMLNS_NAMESPACE;
        if (!isXmlns && attr.namespaceURI && attr.namespaceURI !== SVG_NAMESPACE && attr.namespaceURI !== XLINK_NAMESPACE) {
          let inMeta = localName === "metadata";
          let p: Node | null = el.parentNode;
          while (p && !inMeta) {
            if (p.nodeType === ELEMENT_NODE && (p as Element).localName === "metadata") {
              inMeta = true;
            }
            p = p.parentNode;
          }
          if (inMeta) {
            analyzeOnlyReasons.add("UNSUPPORTED_METADATA_MARKUP");
          } else {
            outOfScopeReasons.add("OUT_OF_SCOPE_NAMESPACE");
          }
        }

        // Active / unsafe attributes
        if (/^on[a-z]+/i.test(attrName)) {
          unsafeReasons.add("UNSAFE_EVENT_HANDLER");
          observedPatterns.add("attribute.event");
        }

        // xml:base is unsafe
        if (
          attrName === "xml:base" ||
          (attrLocal === "base" && (attr.namespaceURI === "http://www.w3.org/XML/1998/namespace" || attrName.startsWith("xml:")))
        ) {
          unsafeReasons.add("UNSAFE_XML_BASE");
          observedPatterns.add("reference.external");
        }

        // External reference checks
        if (attrLocal === "href" || attrLocal === "src" || attrName === "xlink:href") {
          if (isExternalHref(attrVal)) {
            unsafeReasons.add("UNSAFE_EXTERNAL_REFERENCE");
            observedPatterns.add("reference.external");
          }
        }
        if (/url\s*\(/i.test(attrVal)) {
          if (hasExternalUrl(attrVal)) {
            unsafeReasons.add("UNSAFE_EXTERNAL_REFERENCE");
            observedPatterns.add("reference.external");
          }
        }
        if (attrName === "style" && /javascript\s*:/i.test(attrVal)) {
          unsafeReasons.add("UNSAFE_EXTERNAL_REFERENCE");
          observedPatterns.add("reference.external");
        }

        // CSS style / class
        if (attrName === "style") {
          analyzeOnlyReasons.add("UNSUPPORTED_STYLE_ATTRIBUTE");
          observedPatterns.add("attribute.style");
        }
        if (attrName === "class") {
          analyzeOnlyReasons.add("UNSUPPORTED_CLASS_ATTRIBUTE");
          observedPatterns.add("attribute.class");
        }

        // Deferred attributes
        if (attrName === "clip-path") {
          deferredReasons.add("DEFERRED_CLIP_PATH");
          observedPatterns.add("attribute.clip-path");
        }
        if (attrName === "mask") {
          deferredReasons.add("DEFERRED_MASK");
          observedPatterns.add("attribute.mask");
        }

        // Out of scope attributes
        if (attrName === "filter") {
          outOfScopeReasons.add("OUT_OF_SCOPE_FILTER");
        }
        if (attrName.startsWith("marker")) {
          outOfScopeReasons.add("OUT_OF_SCOPE_MARKER");
        }

        // XLink href normalization
        if (attrName === "xlink:href") {
          normalizations.add("xlink_href_to_href");
        }

        // Transforms inspection
        if (attrName === "transform") {
          parseTransforms(attrVal, normalizations, observedPatterns, outOfScopeReasons, invalidReasons);
        }
      }

      // Special check on path data for packed arc flags and byte limit
      if (localName === "path") {
        const d = el.getAttribute("d");
        if (d !== null) {
          if (Buffer.byteLength(d) > SCENE_LIMITS.maxPathBytes) {
            outOfScopeReasons.add("LIMIT_PATH_BYTES_EXCEEDED");
          }
          const diagCtx: DiagnosticContext = { operation: "parse", domain: "svg" };
          try {
            parsePathData(d, diagCtx, "d");
          } catch {
            if (hasPackedArcFlags(d)) {
              analyzeOnlyReasons.add("PARSER_LIMIT_PACKED_ARC_FLAGS");
            } else {
              invalidReasons.add("INVALID_PATH_DATA");
            }
          }
        }
      }

      if (localName === "polyline" || localName === "polygon") {
        const points = el.getAttribute("points");
        if (points !== null) {
          const tokens = points.split(/[\s,]+/).filter(Boolean);
          if (tokens.length > SCENE_LIMITS.maxPoints * 2) {
            outOfScopeReasons.add("LIMIT_POINTS_EXCEEDED");
          }
        }
      }

      // Recurse children
      for (let i = 0; i < el.childNodes.length; i += 1) {
        traverseNode(el.childNodes.item(i)!, depth + 1);
      }
    }
  }

  traverseNode(root, 1);

  // 6. Inspect root SVG specific requirements
  const rootVb = root.getAttribute("viewBox");
  if (!rootVb) {
    analyzeOnlyReasons.add("UNSUPPORTED_VIEWBOX_REQUIRED");
  } else {
    const vbTokens = rootVb.trim().split(/[\t\n\r ,]+/).filter(Boolean);
    if (vbTokens.length !== 4) {
      invalidReasons.add("INVALID_VIEWBOX");
    } else {
      const nums = vbTokens.map(Number);
      if (nums.some((n) => !Number.isFinite(n)) || nums[2]! <= 0 || nums[3]! <= 0) {
        invalidReasons.add("INVALID_VIEWBOX");
      }
    }
  }

  // PreserveAspectRatio check
  const rootPar = root.getAttribute("preserveAspectRatio");
  if (rootPar && !/^(?:none|xMidYMid|xMinYMin)\b/i.test(rootPar.trim())) {
    outOfScopeReasons.add("OUT_OF_SCOPE_ASPECT_RATIO");
  }

  // Accessibility conflict check
  const ariaHidden = root.getAttribute("aria-hidden") === "true";
  const role = root.getAttribute("role");
  const ariaLabelledby = root.getAttribute("aria-labelledby");
  const ariaLabel = root.getAttribute("aria-label");

  let titleElem: Element | null = null;
  let descElem: Element | null = null;
  for (let i = 0; i < root.childNodes.length; i += 1) {
    const child = root.childNodes.item(i);
    if (child && child.nodeType === ELEMENT_NODE) {
      const name = (child as Element).localName;
      if (name === "title" && !titleElem) titleElem = child as Element;
      if (name === "desc" && !descElem) descElem = child as Element;
    }
  }

  if (ariaHidden && (titleElem !== null || role === "img" || ariaLabelledby !== null || ariaLabel !== null)) {
    invalidReasons.add("INVALID_ACCESSIBILITY_CONFLICT");
  }

  // Check defs children
  for (const defs of defsElements) {
    for (let i = 0; i < defs.childNodes.length; i += 1) {
      const child = defs.childNodes.item(i);
      if (child && child.nodeType === ELEMENT_NODE) {
        const cLocal = (child as Element).localName ?? (child as Element).tagName;
        if (!["linearGradient", "radialGradient", "symbol", "clipPath", "mask"].includes(cLocal)) {
          outOfScopeReasons.add("UNSUPPORTED_DEFINITION_ELEMENT");
        }
      }
    }
  }

  // 7. Determine classification and collected reason codes
  const allReasons = Array.from(
    new Set([
      ...unsafeReasons,
      ...invalidReasons,
      ...outOfScopeReasons,
      ...deferredReasons,
      ...analyzeOnlyReasons,
    ]),
  ).sort();

  const features: SceneImportFeatures = {
    tags: Array.from(observedTags).sort(),
    attributes: Array.from(observedAttributes).sort(),
    patterns: Array.from(observedPatterns).sort(),
    complete: featuresComplete,
  };

  let classification: SceneImportClassification;
  if (unsafeReasons.size > 0) {
    classification = "REJECTED_UNSAFE";
  } else if (invalidReasons.size > 0) {
    classification = "INVALID_INPUT";
  } else if (outOfScopeReasons.size > 0) {
    classification = "REJECTED_OUT_OF_SCOPE";
  } else if (deferredReasons.size > 0) {
    classification = "DEFERRED_TIER2";
  } else if (analyzeOnlyReasons.size > 0) {
    classification = "SUPPORTED_ANALYZE_ONLY";
  } else {
    classification = "SUPPORTED_IMPORT";
  }

  if (classification !== "SUPPORTED_IMPORT") {
    return {
      classification,
      reasonCodes: allReasons,
      features,
      normalizations: Array.from(normalizations).sort(),
      sourceSha256,
    };
  }

  // 8. Construct VectorScene for valid imports
  try {
    const vbTokens = rootVb!.trim().split(/[\t\n\r ,]+/).filter(Boolean).map(Number);
    const viewBox = [vbTokens[0]!, vbTokens[1]!, vbTokens[2]!, vbTokens[3]!] as const;

    let width = viewBox[2];
    const widthAttr = root.getAttribute("width");
    if (widthAttr) {
      const parsedW = parseLength(widthAttr, normalizations, outOfScopeReasons);
      if (parsedW !== undefined && parsedW > 0) width = parsedW;
    } else {
      normalizations.add("default_artboard_dimensions");
    }

    let height = viewBox[3];
    const heightAttr = root.getAttribute("height");
    if (heightAttr) {
      const parsedH = parseLength(heightAttr, normalizations, outOfScopeReasons);
      if (parsedH !== undefined && parsedH > 0) height = parsedH;
    } else {
      normalizations.add("default_artboard_dimensions");
    }

    // Accessibility resolution
    let accessibility: SceneAccessibility;
    if (titleElem !== null) {
      const titleText = (titleElem.textContent ?? "").trim();
      const descText = descElem ? (descElem.textContent ?? "").trim() : undefined;
      normalizations.add("title_to_labelled");
      accessibility = {
        mode: "labelled",
        title: titleText || "Untitled",
        ...(descText ? { desc: descText } : {}),
        ...(root.hasAttribute("focusable") ? { focusable: root.getAttribute("focusable") === "true" } : {}),
      };
    } else if (ariaHidden) {
      accessibility = { mode: "decorative" };
    } else {
      normalizations.add("declare_decorative");
      accessibility = { mode: "decorative" };
    }

    if (root.hasAttribute("role") || root.hasAttribute("aria-labelledby") || root.hasAttribute("focusable")) normalizations.add("accessibility_attributes_canonicalized");
    if (root.hasAttribute("version")) normalizations.add("svg_version_attribute_omitted");
    if ([...observedAttributes].some(a => a.startsWith("xmlns:") && a !== "xmlns:xlink")) normalizations.add("unused_namespace_declarations_omitted");

    // Collect definitions
    const gradients: (LinearGradientDef | RadialGradientDef)[] = [];
    const symbols: SymbolDef[] = [];
    const symbolMap = new Map<string, SymbolDef>();

    // Collect all element IDs and establish deterministic collision-free mapping
    const rawIds: string[] = [];
    const idMap = new Map<string, string>();
    const allocatedIds = new Set<string>();

    function inspectIds(el: Element): void {
      const id = el.getAttribute("id");
      if (id) rawIds.push(id);
      for (let i = 0; i < el.childNodes.length; i += 1) {
        const c = el.childNodes.item(i);
        if (c && c.nodeType === ELEMENT_NODE) inspectIds(c as Element);
      }
    }
    inspectIds(root);

    for (const rawId of rawIds) {
      let targetId = rawId;
      // Avoid collision with generated scene-title and scene-desc
      if (targetId === "scene-title" || targetId === "scene-desc") {
        targetId = `elem-${targetId}`;
        normalizations.add("rename_colliding_ids");
      }
      if (!isLocalId(targetId)) {
        targetId = `id_${targetId.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
        normalizations.add("rename_colliding_ids");
      }
      let finalId = targetId;
      let counter = 1;
      while (allocatedIds.has(finalId)) {
        finalId = `${targetId}_${counter++}`;
        normalizations.add("rename_colliding_ids");
      }
      allocatedIds.add(finalId);
      idMap.set(rawId, finalId);
    }

    let generatedId = 0;
    function allocateGeneratedId(): string {
      let id: string;
      do { id = `import_${++generatedId}`; } while (allocatedIds.has(id));
      allocatedIds.add(id);
      return id;
    }

    function remapId(id: string | null): string | undefined {
      if (!id) return undefined;
      return idMap.get(id) ?? (isLocalId(id) ? id : undefined);
    }

    let generatedIdCounter = 1;
    function getOrAllocateElementId(id: string | null): string {
      if (id) {
        return remapId(id) ?? id;
      }
      let genId = `import_${generatedIdCounter++}`;
      while (allocatedIds.has(genId)) {
        genId = `import_${generatedIdCounter++}`;
      }
      allocatedIds.add(genId);
      return genId;
    }

    function remapRef(ref: string): string {
      const clean = ref.startsWith("#") ? ref.slice(1) : ref;
      const remapped = idMap.get(clean) ?? clean;
      return ref.startsWith("#") ? `#${remapped}` : remapped;
    }

    // Parse gradients from defs
    for (const defs of defsElements) {
      for (let i = 0; i < defs.childNodes.length; i += 1) {
        const node = defs.childNodes.item(i);
        if (!node || node.nodeType !== ELEMENT_NODE) continue;
        const el = node as Element;
        const tag = el.localName ?? el.tagName;

        if (tag === "linearGradient") {
          const rawId = el.getAttribute("id") ?? `grad_${gradients.length + 1}`;
          const gId = remapId(rawId) ?? rawId;
          const x1 = parseGradientCoordinate(el.getAttribute("x1") ?? "0", 0, normalizations, outOfScopeReasons);
          const y1 = parseGradientCoordinate(el.getAttribute("y1") ?? "0", 0, normalizations, outOfScopeReasons);
          const x2 = parseGradientCoordinate(el.getAttribute("x2") ?? "1", 1, normalizations, outOfScopeReasons);
          const y2 = parseGradientCoordinate(el.getAttribute("y2") ?? "0", 0, normalizations, outOfScopeReasons);
          const gradientUnits = el.getAttribute("gradientUnits") === "userSpaceOnUse" ? "userSpaceOnUse" : "objectBoundingBox";
          const stops: GradientStop[] = [];

          for (let s = 0; s < el.childNodes.length; s += 1) {
            const stopNode = el.childNodes.item(s);
            if (!stopNode || stopNode.nodeType !== ELEMENT_NODE) continue;
            const stopEl = stopNode as Element;
            if (stopEl.localName !== "stop") continue;
            const offsetRaw = stopEl.getAttribute("offset") ?? "0";
            let offset = 0;
            if (offsetRaw.endsWith("%")) {
              offset = parseFloat(offsetRaw) / 100;
            } else {
              offset = parseFloat(offsetRaw);
            }
            if (!Number.isFinite(offset)) offset = 0;
            offset = Math.max(0, Math.min(1, offset));

            const stopColorRaw = stopEl.getAttribute("stop-color") ?? "#000000";
            const stopColor = parsePaint(stopColorRaw, normalizations, observedPatterns, outOfScopeReasons) ?? { type: "solid", color: "#000000" as HexColor };
            const stopOpacityAttr = stopEl.getAttribute("stop-opacity");
            const stopOpacity = stopOpacityAttr ? parseFloat(stopOpacityAttr) : undefined;

            stops.push({
              offset,
              color: stopColor,
              ...(stopOpacity !== undefined && Number.isFinite(stopOpacity) ? { opacity: stopOpacity } : {}),
            });
          }

          if (stops.length >= 2) {
            gradients.push({
              id: gId,
              type: "linearGradient",
              x1,
              y1,
              x2,
              y2,
              gradientUnits,
              spreadMethod: "pad",
              stops,
            });
          }
        } else if (tag === "radialGradient") {
          const rawId = el.getAttribute("id") ?? `radial_${gradients.length + 1}`;
          const gId = remapId(rawId) ?? rawId;
          const cx = parseGradientCoordinate(el.getAttribute("cx") ?? "0.5", 0.5, normalizations, outOfScopeReasons);
          const cy = parseGradientCoordinate(el.getAttribute("cy") ?? "0.5", 0.5, normalizations, outOfScopeReasons);
          const r = parseGradientCoordinate(el.getAttribute("r") ?? "0.5", 0.5, normalizations, outOfScopeReasons);
          const fx = el.getAttribute("fx") ? parseGradientCoordinate(el.getAttribute("fx")!, cx, normalizations, outOfScopeReasons) : undefined;
          const fy = el.getAttribute("fy") ? parseGradientCoordinate(el.getAttribute("fy")!, cy, normalizations, outOfScopeReasons) : undefined;
          const gradientUnits = el.getAttribute("gradientUnits") === "userSpaceOnUse" ? "userSpaceOnUse" : "objectBoundingBox";
          const stops: GradientStop[] = [];

          for (let s = 0; s < el.childNodes.length; s += 1) {
            const stopNode = el.childNodes.item(s);
            if (!stopNode || stopNode.nodeType !== ELEMENT_NODE) continue;
            const stopEl = stopNode as Element;
            if (stopEl.localName !== "stop") continue;
            const offsetRaw = stopEl.getAttribute("offset") ?? "0";
            let offset = 0;
            if (offsetRaw.endsWith("%")) {
              offset = parseFloat(offsetRaw) / 100;
            } else {
              offset = parseFloat(offsetRaw);
            }
            if (!Number.isFinite(offset)) offset = 0;
            offset = Math.max(0, Math.min(1, offset));

            const stopColorRaw = stopEl.getAttribute("stop-color") ?? "#000000";
            const stopColor = parsePaint(stopColorRaw, normalizations, observedPatterns, outOfScopeReasons) ?? { type: "solid", color: "#000000" as HexColor };
            const stopOpacityAttr = stopEl.getAttribute("stop-opacity");
            const stopOpacity = stopOpacityAttr ? parseFloat(stopOpacityAttr) : undefined;

            stops.push({
              offset,
              color: stopColor,
              ...(stopOpacity !== undefined && Number.isFinite(stopOpacity) ? { opacity: stopOpacity } : {}),
            });
          }

          if (stops.length >= 2 && r > 0) {
            gradients.push({
              id: gId,
              type: "radialGradient",
              cx,
              cy,
              r,
              ...(fx !== undefined ? { fx } : {}),
              ...(fy !== undefined ? { fy } : {}),
              gradientUnits,
              spreadMethod: "pad",
              stops,
            });
          }
        }
      }
    }

    // Convert Element to SceneElement
    function convertElement(el: Element): SceneElement | null {
      const tag = el.localName ?? el.tagName;
      const elId = remapId(el.getAttribute("id")) ?? allocateGeneratedId();
      const rawPres = extractPresentation(el, normalizations, observedPatterns, outOfScopeReasons);
      const transformAttr = el.getAttribute("transform");
      const transform = transformAttr
        ? parseTransforms(transformAttr, normalizations, observedPatterns, outOfScopeReasons, invalidReasons)
        : undefined;

      // Remap gradient references in fill/stroke
      let fill = rawPres.fill;
      if (fill && fill.type === "gradient") {
        fill = { ...fill, id: remapRef(fill.id) };
      }
      let stroke = rawPres.stroke;
      if (stroke && stroke.type === "gradient") {
        stroke = { ...stroke, id: remapRef(stroke.id) };
      }
      const presentation: Presentation | undefined =
        Object.keys(rawPres).length > 0 ? { ...rawPres, ...(fill ? { fill } : {}), ...(stroke ? { stroke } : {}) } : undefined;

      const base = {
        ...(elId ? { id: elId } : {}),
        ...(presentation ? { presentation } : {}),
        ...(transform && transform.length > 0 ? { transform } : {}),
      };

      switch (tag) {
        case "path": {
          const d = el.getAttribute("d") ?? "";
          return { type: "path", ...base, d };
        }
        case "rect": {
          const x = parseLength(el.getAttribute("x") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          const y = parseLength(el.getAttribute("y") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          const w = parseLength(el.getAttribute("width") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          const h = parseLength(el.getAttribute("height") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          let rx = el.getAttribute("rx") ? parseLength(el.getAttribute("rx")!, normalizations, outOfScopeReasons) : undefined;
          let ry = el.getAttribute("ry") ? parseLength(el.getAttribute("ry")!, normalizations, outOfScopeReasons) : undefined;

          if (rx !== undefined && ry === undefined) {
            ry = rx;
            normalizations.add("rect_corner_completion");
          } else if (ry !== undefined && rx === undefined) {
            rx = ry;
            normalizations.add("rect_corner_completion");
          }

          if (rx !== undefined && rx > w / 2) {
            rx = w / 2;
            normalizations.add("rect_corner_radii_clamped");
          }
          if (ry !== undefined && ry > h / 2) {
            ry = h / 2;
            normalizations.add("rect_corner_radii_clamped");
          }

          return {
            type: "rect",
            ...base,
            x,
            y,
            width: w,
            height: h,
            ...(rx !== undefined ? { rx } : {}),
            ...(ry !== undefined ? { ry } : {}),
          };
        }
        case "circle": {
          const cx = parseLength(el.getAttribute("cx") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          const cy = parseLength(el.getAttribute("cy") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          const r = parseLength(el.getAttribute("r") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          return { type: "circle", ...base, cx, cy, r };
        }
        case "ellipse": {
          const cx = parseLength(el.getAttribute("cx") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          const cy = parseLength(el.getAttribute("cy") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          const rx = parseLength(el.getAttribute("rx") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          const ry = parseLength(el.getAttribute("ry") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          return { type: "ellipse", ...base, cx, cy, rx, ry };
        }
        case "line": {
          const x1 = parseLength(el.getAttribute("x1") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          const y1 = parseLength(el.getAttribute("y1") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          const x2 = parseLength(el.getAttribute("x2") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          const y2 = parseLength(el.getAttribute("y2") ?? "0", normalizations, outOfScopeReasons) ?? 0;
          return { type: "line", ...base, x1, y1, x2, y2 };
        }
        case "polyline":
        case "polygon": {
          const pointsAttr = el.getAttribute("points") ?? "";
          const tokens = pointsAttr.trim().split(/[\t\n\r ,]+/).filter(Boolean);
          const points: (readonly [number, number])[] = [];
          for (let p = 0; p < tokens.length; p += 2) {
            if (tokens[p + 1] !== undefined) {
              points.push([Number(tokens[p]), Number(tokens[p + 1])]);
            }
          }
          return { type: tag, ...base, points };
        }
        case "g": {
          const children: SceneElement[] = [];
          for (let c = 0; c < el.childNodes.length; c += 1) {
            const childNode = el.childNodes.item(c);
            if (childNode && childNode.nodeType === ELEMENT_NODE) {
              const converted = convertElement(childNode as Element);
              if (converted) children.push(converted);
            }
          }
          return { type: "group", ...base, children };
        }
        case "use": {
          const hrefAttr = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
          const href = remapRef(hrefAttr);
          const x = el.getAttribute("x") ? parseLength(el.getAttribute("x")!, normalizations, outOfScopeReasons) : undefined;
          const y = el.getAttribute("y") ? parseLength(el.getAttribute("y")!, normalizations, outOfScopeReasons) : undefined;
          const w = el.getAttribute("width") ? parseLength(el.getAttribute("width")!, normalizations, outOfScopeReasons) : undefined;
          const h = el.getAttribute("height") ? parseLength(el.getAttribute("height")!, normalizations, outOfScopeReasons) : undefined;

          return {
            type: "use",
            ...base,
            href: href.startsWith("#") ? href : `#${href}`,
            ...(x !== undefined ? { x } : {}),
            ...(y !== undefined ? { y } : {}),
            ...(w !== undefined ? { width: w } : {}),
            ...(h !== undefined ? { height: h } : {}),
          };
        }
        default:
          return null;
      }
    }

    // Parse symbols from defs
    for (const defs of defsElements) {
      for (let i = 0; i < defs.childNodes.length; i += 1) {
        const node = defs.childNodes.item(i);
        if (!node || node.nodeType !== ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.localName === "symbol") {
          const rawId = el.getAttribute("id");
          if (!rawId) continue;
          const sId = remapId(rawId) ?? rawId;
          const sVbAttr = el.getAttribute("viewBox");
          if (!sVbAttr) continue;
          const sVbTokens = sVbAttr.trim().split(/[\t\n\r ,]+/).filter(Boolean).map(Number);
          if (sVbTokens.length !== 4 || sVbTokens.some((n) => !Number.isFinite(n))) continue;
          const sViewBox = [sVbTokens[0]!, sVbTokens[1]!, sVbTokens[2]!, sVbTokens[3]!] as const;
          const sElements: SceneElement[] = [];

          for (let c = 0; c < el.childNodes.length; c += 1) {
            const child = el.childNodes.item(c);
            if (child && child.nodeType === ELEMENT_NODE) {
              const converted = convertElement(child as Element);
              if (converted) sElements.push(converted);
            }
          }

          const symbolDef: SymbolDef = {
            id: sId,
            type: "symbol",
            viewBox: sViewBox,
            elements: sElements,
          };
          symbols.push(symbolDef);
          symbolMap.set(sId, symbolDef);
        }
      }
    }

    // Convert top-level artwork elements
    let elements: SceneElement[] = [];
    for (let i = 0; i < root.childNodes.length; i += 1) {
      const child = root.childNodes.item(i);
      if (!child || child.nodeType !== ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.localName ?? el.tagName;
      if (tag === "defs" || tag === "title" || tag === "desc" || tag === "metadata") continue;
      const converted = convertElement(el);
      if (converted) elements.push(converted);
    }

    // Root presentation promotion
    const rawRootPres = extractPresentation(root, normalizations, observedPatterns, outOfScopeReasons);
    const rootPres = {
      ...rawRootPres,
      ...(rawRootPres.fill?.type === "gradient" ? { fill: { ...rawRootPres.fill, id: remapRef(rawRootPres.fill.id) } } : {}),
      ...(rawRootPres.stroke?.type === "gradient" ? { stroke: { ...rawRootPres.stroke, id: remapRef(rawRootPres.stroke.id) } } : {}),
    };
    if (Object.keys(rootPres).length > 0 && elements.length > 0) {
      normalizations.add("promote_root_presentation");
      const wrappedGroup: GroupElement = {
        type: "group",
        id: allocateGeneratedId(),
        presentation: rootPres,
        children: [...elements],
      };
      elements = [wrappedGroup];
    }

    // Metadata note extraction
    let metadataNote: string | undefined;
    const metadataElements = Array.from(root.getElementsByTagName("metadata"));
    if (metadataElements.length > 0) {
      const textVal = (metadataElements[0]!.textContent ?? "").trim();
      if (textVal) {
        metadataNote = textVal.slice(0, 4096);
      }
    }

    // Re-check classification after conversion
    if (outOfScopeReasons.size > 0 || invalidReasons.size > 0 || unsafeReasons.size > 0) {
      const finalReasons = Array.from(
        new Set([
          ...unsafeReasons,
          ...invalidReasons,
          ...outOfScopeReasons,
          ...deferredReasons,
          ...analyzeOnlyReasons,
        ]),
      ).sort();

      const finalClassification: SceneImportClassification =
        unsafeReasons.size > 0
          ? "REJECTED_UNSAFE"
          : invalidReasons.size > 0
            ? "INVALID_INPUT"
            : "REJECTED_OUT_OF_SCOPE";

      return {
        classification: finalClassification,
        reasonCodes: finalReasons,
        features,
        normalizations: Array.from(normalizations).sort(),
        sourceSha256,
      };
    }

    const definitions: SceneDefinitions | undefined =
      gradients.length > 0 || symbols.length > 0
        ? {
            ...(gradients.length > 0 ? { gradients } : {}),
            ...(symbols.length > 0 ? { symbols } : {}),
          }
        : undefined;

    const scene: VectorScene = {
      schema: SCENE_SCHEMA,
      compatibility: SCENE_COMPATIBILITY,
      compilerLevel: SCENE_COMPILER_LEVEL,
      profile: "illustration",
      artboard: {
        width,
        height,
        viewBox,
        policy: "contain",
      },
      accessibility,
      elements,
      ...(definitions ? { definitions } : {}),
      provenance: {
        sourceDigest: sourceSha256,
        ...(metadataNote ? { note: metadataNote } : {}),
      },
    };

    // 9. Validation and Compilation Acceptance Gate
    const valResult = validateScene(scene);
    if (!valResult.ok) {
      const diagCodes = valResult.diagnostics.map((d) => d.code);
      return {
        classification: "REJECTED_OUT_OF_SCOPE",
        reasonCodes: diagCodes,
        features,
        normalizations: Array.from(normalizations).sort(),
        sourceSha256,
      };
    }

    const compileResult = compileScene(scene);
    if (!compileResult.ok) {
      const diagCodes = compileResult.diagnostics.map((d) => d.code);
      return {
        classification: "REJECTED_OUT_OF_SCOPE",
        reasonCodes: diagCodes,
        features,
        normalizations: Array.from(normalizations).sort(),
        sourceSha256,
      };
    }

    const canonicalRes = canonicalizeScene(scene);
    if (!canonicalRes.ok || Buffer.byteLength(canonicalRes.value) > MAX_INPUT_BYTES) {
      return { classification: "REJECTED_OUT_OF_SCOPE", reasonCodes: ["LIMIT_CANONICAL_SCENE_BYTES_EXCEEDED"], features, normalizations: [...normalizations].sort(), sourceSha256 };
    }
    const canonicalScene = canonicalRes.value;

    return {
      classification: "SUPPORTED_IMPORT",
      reasonCodes: [],
      features: { ...features, patterns: [...observedPatterns].sort() },
      scene,
      ...(canonicalScene !== undefined ? { canonicalScene } : {}),
      normalizations: Array.from(normalizations).sort(),
      sourceSha256,
    };
  } catch (error) {
    throw error;
  }
}
