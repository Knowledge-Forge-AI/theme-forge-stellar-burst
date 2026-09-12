import type { Element } from "@xmldom/xmldom";
import { SCENE_LIMITS } from "./constants.js";

// Limit ceilings per TFSB62A specification
export const MAX_INPUT_BYTES = 8 * 1024 * 1024; // 8 MiB
export const MAX_XML_DEPTH = 128;
export const MAX_XML_NODES = 100_000;
export const MAX_AGGREGATE_ATTRIBUTES = 100_000;
export const MAX_PER_ELEMENT_ATTRIBUTES = 64;

export const ARTWORK_TAGS = new Set([
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "use",
]);

export const ALLOWED_GEOMETRY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  svg: ["viewBox", "width", "height", "version", "role", "aria-labelledby", "aria-hidden", "focusable", "preserveAspectRatio"],
  g: [],
  path: ["d"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  use: ["href", "xlink:href", "x", "y", "width", "height"],
  defs: [],
  symbol: ["viewBox", "preserveAspectRatio", "overflow"],
  linearGradient: ["x1", "y1", "x2", "y2", "gradientUnits", "spreadMethod"],
  radialGradient: ["cx", "cy", "r", "fx", "fy", "gradientUnits", "spreadMethod"],
  stop: ["offset", "stop-color", "stop-opacity"],
  title: [],
  desc: [],
});

export const ALLOWED_PRESENTATION = new Set([
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity",
  "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule", "aria-hidden",
]);

/** Count structure without constructing an XML DOM. XML syntax is checked later. */
export function guardSvgXml(text: string): string | undefined {
  let position = 0, depth = 0, nodes = 0, attributes = 0;
  while (position < text.length) {
    const start = text.indexOf("<", position);
    if (start < 0) {
      if (position < text.length) nodes++;
      break;
    }
    if (start > position) nodes++;
    if (nodes > MAX_XML_NODES) return "LIMIT_XML_NODES_EXCEEDED";
    let end: number;
    if (text.startsWith("<!--", start)) {
      end = text.indexOf("-->", start + 4);
      if (end < 0) return undefined;
      nodes++; position = end + 3;
    } else if (text.startsWith("<![CDATA[", start)) {
      end = text.indexOf("]]>", start + 9);
      if (end < 0) return undefined;
      nodes++; position = end + 3;
    } else if (text.startsWith("<?", start)) {
      end = text.indexOf("?>", start + 2);
      if (end < 0) return undefined;
      nodes++; position = end + 2;
    } else {
      let quote = "", count = 0;
      end = start + 1;
      for (; end < text.length; end++) {
        const c = text[end]!;
        if (quote) { if (c === quote) quote = ""; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === "=") count++;
        else if (c === ">") break;
      }
      if (end === text.length) return undefined;
      if (text[start + 1] === "/") depth--;
      else if (text[start + 1] !== "!") {
        nodes++; attributes += count;
        if (count > MAX_PER_ELEMENT_ATTRIBUTES) return "LIMIT_PER_ELEMENT_ATTRIBUTES_EXCEEDED";
        if (attributes > MAX_AGGREGATE_ATTRIBUTES) return "LIMIT_AGGREGATE_ATTRIBUTES_EXCEEDED";
        if (depth + 1 > MAX_XML_DEPTH) return "LIMIT_XML_DEPTH_EXCEEDED";
        if (text[end - 1] !== "/") depth++;
      }
      position = end + 1;
    }
    if (nodes > MAX_XML_NODES) return "LIMIT_XML_NODES_EXCEEDED";
  }
  return nodes > MAX_XML_NODES ? "LIMIT_XML_NODES_EXCEEDED" : undefined;
}

const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const length = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:px)?$/;
export interface ImportFindings {
  unsafe: Set<string>;
  unsupported: Set<string>;
  invalid: Set<string>;
  limits: Set<string>;
  patterns: Set<string>;
}

/** Freeze the translator's closed semantics before any conversion may omit data. */
export function inspectImportSemantics(root: Element, findings: ImportFindings): void {
  const ids = new Map<string, Element>();
  const elements = [root, ...Array.from(root.getElementsByTagName("*"))];
  for (const el of elements) {
    const tag = el.localName ?? el.nodeName;
    const id = el.getAttribute("id");
    if (id !== null) {
      if (!id || /\s/.test(id)) findings.unsupported.add("UNSUPPORTED_SOURCE_ID");
      if (ids.has(id)) findings.invalid.add("DUPLICATE_SOURCE_ID");
      ids.set(id, el);
    }
    if (el.namespaceURI !== "http://www.w3.org/2000/svg") findings.unsupported.add("UNSUPPORTED_NAMESPACE");
    if (tag === "metadata") findings.unsupported.add("UNSUPPORTED_METADATA_MARKUP");
    if (tag === "svg" && el.hasAttribute("version") && !["1.0", "1.1"].includes(el.getAttribute("version")!)) findings.unsupported.add("UNSUPPORTED_SVG_VERSION");
    if (tag === "linearGradient" || tag === "radialGradient") {
      const stops = Array.from(el.childNodes).filter(n => n.nodeType === 1 && (n as Element).localName === "stop");
      if (stops.length < 2) findings.unsupported.add("UNSUPPORTED_GRADIENT_STOP_COUNT");
      if (el.getAttribute("gradientUnits") === "userSpaceOnUse") {
        const required = tag === "linearGradient" ? ["x1", "y1", "x2", "y2"] : ["cx", "cy", "r"];
        if (required.some(a => !el.hasAttribute(a)) || [...required, "fx", "fy"].some(a => el.getAttribute(a)?.includes("%"))) findings.unsupported.add("UNSUPPORTED_USER_SPACE_GRADIENT_VIEWPORT");
      }
    }
    const allowed = new Set(["id", ...(ALLOWED_GEOMETRY[tag] ?? [])]);
    if (tag === "svg" || ARTWORK_TAGS.has(tag)) for (const a of ALLOWED_PRESENTATION) allowed.add(a);
    if (ARTWORK_TAGS.has(tag)) allowed.add("transform");
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name, value = attr.value.trim();
      if (name === "xml:base" || attr.localName === "base" && attr.namespaceURI === "http://www.w3.org/XML/1998/namespace") findings.unsafe.add("UNSAFE_XML_BASE");
      if ((attr.localName === "href" || attr.localName === "src") && !/^#[^\s#]+$/.test(value)) findings.unsafe.add("UNSAFE_EXTERNAL_REFERENCE");
      for (const match of value.matchAll(/url\s*\(\s*([^)]+)\s*\)/gi)) {
        const target = (match[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
        if (!/^#[^\s#]+$/.test(target)) findings.unsafe.add("UNSAFE_EXTERNAL_REFERENCE");
      }
      if ((attr.localName === "href" || /url\s*\(/i.test(value)) && value.includes("%")) findings.unsupported.add("UNSUPPORTED_REFERENCE_ENCODING");
      if (name === "xmlns" || name.startsWith("xmlns:")) continue;
      if (!allowed.has(name) && !["style", "class", "clip-path", "mask", "filter"].includes(name) && !/^on/i.test(name)) findings.unsupported.add("UNSUPPORTED_ATTRIBUTE");
      if (name === "transform") findings.patterns.add("transform");
      if (ALLOWED_PRESENTATION.has(name) && (tag === "g" || tag === "svg")) findings.patterns.add("presentation.inheritance");
      if (/opacity$/.test(name)) findings.patterns.add("opacity");
      if (value === "currentColor") findings.patterns.add("currentColor");
      if (["opacity", "fill-opacity", "stroke-opacity", "stop-opacity"].includes(name) && (!number.test(value) || Number(value) < 0 || Number(value) > 1)) findings.unsupported.add("UNSUPPORTED_OPACITY_VALUE");
      const enums: Record<string, string[]> = { "stroke-linecap": ["butt", "round", "square"], "stroke-linejoin": ["miter", "round", "bevel"], "fill-rule": ["nonzero", "evenodd"], "clip-rule": ["nonzero", "evenodd"], "aria-hidden": ["true", "false"], focusable: ["true", "false"], gradientUnits: ["userSpaceOnUse", "objectBoundingBox"], spreadMethod: ["pad"] };
      if (enums[name] && !enums[name]!.includes(value)) findings.unsupported.add("UNSUPPORTED_ATTRIBUTE_VALUE");
      if (["x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "width", "height", "stroke-width", "stroke-miterlimit", "stroke-dashoffset"].includes(name)) {
        const gradient = tag === "linearGradient" || tag === "radialGradient";
        const accepted = gradient && value.endsWith("%") ? number.test(value.slice(0, -1)) : length.test(value);
        if (!accepted || !Number.isFinite(parseFloat(value))) findings.unsupported.add("UNSUPPORTED_LENGTH_VALUE");
        if (["r", "rx", "ry", "width", "height", "stroke-width"].includes(name) && parseFloat(value) < 0) findings.invalid.add("INVALID_NEGATIVE_GEOMETRY");
        if (tag === "svg" && ["width", "height"].includes(name) && parseFloat(value) <= 0) findings.unsupported.add("UNSUPPORTED_ZERO_VIEWPORT");
        if (name === "stroke-miterlimit" && parseFloat(value) < 1) findings.unsupported.add("UNSUPPORTED_ATTRIBUTE_VALUE");
      }
      if (name === "preserveAspectRatio" && !["xMidYMid", "xMidYMid meet"].includes(value)) findings.unsupported.add("UNSUPPORTED_ASPECT_RATIO");
      if (name === "viewBox") {
        const values = value.split(/[\s,]+/);
        if (values.length !== 4 || values.some(v => !number.test(v) || !Number.isFinite(Number(v)))) findings.invalid.add("INVALID_VIEWBOX");
      }
      if (name === "overflow" && value !== "hidden") findings.unsupported.add("UNSUPPORTED_SYMBOL_OVERFLOW");
      if (tag === "stop" && name === "offset") {
        const numeric = value.endsWith("%") ? value.slice(0, -1) : value;
        if (!number.test(numeric) || !Number.isFinite(Number(numeric))) findings.invalid.add("INVALID_GRADIENT_OFFSET");
      }
      if (tag === "stop" && name === "stop-color" && ["none", "transparent"].includes(value)) findings.unsupported.add("UNSUPPORTED_GRADIENT_STOP_PAINT");
      if (name === "d" && Buffer.byteLength(value) > SCENE_LIMITS.maxPathBytes) findings.limits.add("LIMIT_PATH_BYTES_EXCEEDED");
      if (name === "points") {
        const tokens = value.split(/[\s,]+/).filter(Boolean);
        if (tokens.length > SCENE_LIMITS.maxPoints * 2) findings.limits.add("LIMIT_POINTS_EXCEEDED");
        if (tokens.length % 2 || tokens.some(t => !number.test(t))) findings.unsupported.add("PARSER_LIMIT_POINTS_SYNTAX");
      }
      if (name === "stroke-dasharray") {
        const values = value.split(/[\s,]+/).filter(Boolean);
        if (value === "none") findings.unsupported.add("UNSUPPORTED_DASH_RESET");
        else if (values.some(v => !length.test(v) || parseFloat(v) < 0)) findings.unsupported.add("UNSUPPORTED_DASH_VALUE");
      }
    }
    const parent = el.parentNode?.nodeType === 1 ? (el.parentNode as Element).localName : null;
    if (tag === "symbol" || tag === "linearGradient" || tag === "radialGradient") {
      if (parent !== "defs") findings.unsupported.add("UNSUPPORTED_DEFINITION_PLACEMENT");
    }
    if (tag === "defs" && parent !== "svg") findings.unsupported.add("UNSUPPORTED_DEFINITION_PLACEMENT");
    if (tag === "stop" && parent !== "linearGradient" && parent !== "radialGradient") findings.unsupported.add("UNSUPPORTED_STOP_PLACEMENT");
    if ((tag === "title" || tag === "desc") && parent !== "svg") findings.unsupported.add("UNSUPPORTED_NESTED_ACCESSIBILITY");
    if (ARTWORK_TAGS.has(tag) && parent && !["svg", "g", "symbol", "clipPath", "mask", "defs"].includes(parent)) findings.unsupported.add("UNSUPPORTED_ELEMENT_PLACEMENT");
    for (const child of Array.from(el.childNodes)) {
      if ((child.nodeType === 3 || child.nodeType === 4) && child.nodeValue?.trim() && !["title", "desc", "style", "text", "tspan", "metadata"].includes(tag)) findings.unsupported.add("UNSUPPORTED_TEXT_CONTENT");
      if (child.nodeType === 4) findings.unsupported.add("UNSUPPORTED_CDATA");
    }
    if (tag === "use" && (!el.hasAttribute("width") || !el.hasAttribute("height"))) findings.unsupported.add("UNSUPPORTED_USE_IMPLICIT_VIEWPORT");
  }
  for (const el of elements) {
    for (const attr of Array.from(el.attributes)) {
      const value = attr.value.trim();
      const ref = attr.localName === "href" && value.startsWith("#") ? value.slice(1) : /^url\(#([^()]+)\)$/.exec(value)?.[1];
      if (ref !== undefined && !ids.has(ref)) findings.invalid.add("MISSING_LOCAL_REFERENCE");
    }
  }
  const titles = elements.filter(el => el.localName === "title" && el.parentNode === root);
  const descriptions = elements.filter(el => el.localName === "desc" && el.parentNode === root);
  if (titles.length > 1 || descriptions.length > 1 || titles.some(el => !el.textContent?.trim()) || !titles.length && descriptions.length) findings.unsupported.add("UNSUPPORTED_ACCESSIBILITY");
  const role = root.getAttribute("role");
  if (role && role !== (titles.length ? "img" : "presentation")) findings.unsupported.add("UNSUPPORTED_ACCESSIBILITY_ROLE");
  if (root.getAttribute("focusable") === "true" && !titles.length) findings.unsupported.add("UNSUPPORTED_ACCESSIBILITY_FOCUS");
  const labelledBy = root.getAttribute("aria-labelledby");
  if (!titles.length && root.getAttribute("aria-hidden") === "false") findings.unsupported.add("UNSUPPORTED_ACCESSIBILITY_CONFLICT");
  if (labelledBy !== null) {
    const expected = [...titles, ...descriptions].map(el => el.getAttribute("id")).filter(Boolean).join(" ");
    if (!expected || labelledBy.trim().split(/\s+/).join(" ") !== expected) findings.unsupported.add("UNSUPPORTED_ACCESSIBILITY_REFERENCE");
  }
}
