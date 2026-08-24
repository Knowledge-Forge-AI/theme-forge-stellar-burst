import { DOMParser, MIME_TYPE, ParseError, onWarningStopParsing, type Document, type Element, type Node } from "@xmldom/xmldom";

import { DiagnosticError, fail, fromCaught, ok, type DiagnosticContext } from "./diagnostics.js";
import { formatNumber, normalizeText, parseHexColor, parseLocalId, parseNumberText, parsePathData } from "./primitives.js";
import type { ArtworkElementV2, DefinitionsV2, ElementPresentationV2, NormalizedAssetV2, PaintV2, PresentationV2, SvgDocumentV2, TransformOperationV2 } from "./schema2-types.js";
import { validateSvgDocumentV2 } from "./schema2-validation.js";
import { serializeSvg } from "./svg.js";
import type { GradientStop, LinearGradient, Result, ShapeRendering, SvgDocument } from "./types.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const MAX_SVG_SOURCE_LENGTH = 8 * 1024 * 1024;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;
const DOCUMENT_TYPE_NODE = 10;
const PRESENTATION_ATTRIBUTES = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule"] as const;

function context(source: string | undefined, operation: "parse" | "serialize" = "parse"): DiagnosticContext {
  return { operation, domain: "svg", ...(source === undefined ? {} : { source }) };
}

function preflightXml(text: string, ctx: DiagnosticContext): void {
  if (text.length > MAX_SVG_SOURCE_LENGTH) fail(ctx, "XML_LIMIT_EXCEEDED", "SVG input exceeds the 8 MiB limit.");
  let position = 0;
  let declarationSeen = false;
  while (position < text.length) {
    const start = text.indexOf("<", position);
    if (start === -1) break;
    if (text.startsWith("<!--", start)) {
      const end = text.indexOf("-->", start + 4);
      if (end === -1) return;
      position = end + 3;
      continue;
    }
    if (text.startsWith("<?", start)) {
      const end = text.indexOf("?>", start + 2);
      if (end === -1) return;
      const instruction = text.slice(start, end + 2);
      const prefix = text.slice(0, start).replace(/^\uFEFF/, "");
      const declaration = /^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])UTF-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>$/i;
      if (declarationSeen || prefix.trim() !== "" || !declaration.test(instruction)) fail(ctx, "XML_UNSUPPORTED_PROCESSING_INSTRUCTION", "Only one leading XML 1.0 UTF-8 declaration is supported.");
      declarationSeen = true;
      position = end + 2;
      continue;
    }
    if (text.startsWith("<!", start)) fail(ctx, "XML_UNSAFE_DECLARATION", "DOCTYPE, entity, CDATA, and other XML declarations are unsupported.");
    position = start + 1;
  }
}

function childElements(parent: Node, ctx: DiagnosticContext, path: string): readonly Element[] {
  const result: Element[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const node = parent.childNodes.item(index);
    if (node === null || node.nodeType === COMMENT_NODE) continue;
    if (node.nodeType === TEXT_NODE && (node.nodeValue ?? "").trim() === "") continue;
    if (node.nodeType === ELEMENT_NODE) { result.push(node as Element); continue; }
    const code = node.nodeType === PROCESSING_INSTRUCTION_NODE ? "XML_UNSUPPORTED_PROCESSING_INSTRUCTION" : node.nodeType === DOCUMENT_TYPE_NODE ? "XML_UNSAFE_DECLARATION" : node.nodeType === CDATA_NODE ? "XML_UNSUPPORTED_CDATA" : "XML_UNSUPPORTED_NODE";
    fail(ctx, code, "Unsupported XML node in schema-2 SVG.", path);
  }
  return result;
}

function assertSvgElement(element: Element, ctx: DiagnosticContext, path: string): void {
  if (element.namespaceURI !== SVG_NAMESPACE || (element.prefix !== null && element.prefix !== "")) fail(ctx, "XML_UNSUPPORTED_NAMESPACE", "Only unprefixed SVG namespace elements are supported.", path);
}

function attributes(element: Element, allowed: readonly string[], ctx: DiagnosticContext, path: string): ReadonlyMap<string, string> {
  assertSvgElement(element, ctx, path);
  const allowedSet = new Set(allowed);
  const result = new Map<string, string>();
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute === null) continue;
    if (attribute.namespaceURI === XMLNS_NAMESPACE || attribute.name === "xmlns") {
      if (attribute.name !== "xmlns" || attribute.value !== SVG_NAMESPACE) fail(ctx, "XML_UNSUPPORTED_NAMESPACE", "Only the default SVG namespace is supported.", `${path}/@${attribute.name}`);
      result.set("xmlns", attribute.value);
      continue;
    }
    if ((attribute.namespaceURI !== null && attribute.namespaceURI !== "") || !allowedSet.has(attribute.name)) {
      const unsafe = /^on/i.test(attribute.name) || attribute.name === "style" || attribute.name === "class";
      fail(ctx, unsafe ? "XML_ACTIVE_CONTENT" : "XML_UNSUPPORTED_ATTRIBUTE", `Unsupported SVG attribute '${attribute.name}'.`, `${path}/@${attribute.name}`);
    }
    result.set(attribute.name, attribute.value);
  }
  return result;
}

function required(values: ReadonlyMap<string, string>, name: string, ctx: DiagnosticContext, path: string): string {
  const value = values.get(name);
  if (value === undefined || value === "") fail(ctx, "XML_MISSING_ATTRIBUTE", `Missing required SVG attribute '${name}'.`, `${path}/@${name}`);
  return value;
}

function textOnly(element: Element, ctx: DiagnosticContext, path: string): string {
  let text = "";
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const node = element.childNodes.item(index);
    if (node === null || node.nodeType === COMMENT_NODE) continue;
    if (node.nodeType !== TEXT_NODE) fail(ctx, "XML_UNSUPPORTED_MARKUP", "This SVG element accepts text only.", path);
    text += node.nodeValue ?? "";
  }
  return normalizeText(text);
}

function parsePaint(value: string, ctx: DiagnosticContext, location: string): PaintV2 {
  if (value === "none") return { type: "none" };
  if (value === "currentColor") return { type: "currentColor" };
  const gradient = /^url\(#([^)]+)\)(?:[\t\n\r ]+(#[0-9A-Fa-f]{6}))?$/.exec(value);
  if (gradient !== null) return { type: "linear-gradient", reference: parseLocalId(gradient[1], ctx, location), ...(gradient[2] === undefined ? {} : { fallback: parseHexColor(gradient[2], ctx, location) }) };
  if (/^url\(/i.test(value)) fail(ctx, "XML_EXTERNAL_REFERENCE", "Paint URLs must be asset-local linear gradients.", location);
  return { type: "solid", color: parseHexColor(value, ctx, location) };
}

function parseUnit(value: string | undefined, ctx: DiagnosticContext, location: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseNumberText(value, ctx, location);
  if (parsed < 0 || parsed > 1) fail(ctx, "XML_INVALID_RANGE", "Expected a number in [0, 1].", location);
  return parsed;
}

function parsePresentation(values: ReadonlyMap<string, string>, ctx: DiagnosticContext, path: string, element: boolean): ElementPresentationV2 {
  const width = values.get("stroke-width") === undefined ? undefined : parseNumberText(values.get("stroke-width")!, ctx, `${path}/@stroke-width`);
  if (width !== undefined && width < 0) fail(ctx, "XML_INVALID_RANGE", "stroke-width must be non-negative.", `${path}/@stroke-width`);
  const miter = values.get("stroke-miterlimit") === undefined ? undefined : parseNumberText(values.get("stroke-miterlimit")!, ctx, `${path}/@stroke-miterlimit`);
  if (miter !== undefined && miter < 1) fail(ctx, "XML_INVALID_RANGE", "stroke-miterlimit must be at least 1.", `${path}/@stroke-miterlimit`);
  const linecap = values.get("stroke-linecap");
  if (linecap !== undefined && !["butt", "round", "square"].includes(linecap)) fail(ctx, "XML_INVALID_ENUM", "Unsupported stroke-linecap.", `${path}/@stroke-linecap`);
  const linejoin = values.get("stroke-linejoin");
  if (linejoin !== undefined && !["miter", "round", "bevel"].includes(linejoin)) fail(ctx, "XML_INVALID_ENUM", "Unsupported stroke-linejoin.", `${path}/@stroke-linejoin`);
  const fillRule = values.get("fill-rule");
  const clipRule = values.get("clip-rule");
  if (fillRule !== undefined && !["nonzero", "evenodd"].includes(fillRule)) fail(ctx, "XML_INVALID_ENUM", "Unsupported fill-rule.", `${path}/@fill-rule`);
  if (clipRule !== undefined && !["nonzero", "evenodd"].includes(clipRule)) fail(ctx, "XML_INVALID_ENUM", "Unsupported clip-rule.", `${path}/@clip-rule`);
  const aria = values.get("aria-hidden");
  if (aria !== undefined && aria !== "true" && aria !== "false") fail(ctx, "XML_INVALID_ENUM", "aria-hidden must be true or false.", `${path}/@aria-hidden`);
  return { ...(values.get("fill") === undefined ? {} : { fill: parsePaint(values.get("fill")!, ctx, `${path}/@fill`) }), ...(values.get("stroke") === undefined ? {} : { stroke: parsePaint(values.get("stroke")!, ctx, `${path}/@stroke`) }), ...(width === undefined ? {} : { strokeWidth: width }), ...(linecap === undefined ? {} : { strokeLinecap: linecap as "butt" | "round" | "square" }), ...(linejoin === undefined ? {} : { strokeLinejoin: linejoin as "miter" | "round" | "bevel" }), ...(miter === undefined ? {} : { strokeMiterlimit: miter }), ...(parseUnit(values.get("opacity"), ctx, `${path}/@opacity`) === undefined ? {} : { opacity: parseUnit(values.get("opacity"), ctx, `${path}/@opacity`)! }), ...(parseUnit(values.get("fill-opacity"), ctx, `${path}/@fill-opacity`) === undefined ? {} : { fillOpacity: parseUnit(values.get("fill-opacity"), ctx, `${path}/@fill-opacity`)! }), ...(parseUnit(values.get("stroke-opacity"), ctx, `${path}/@stroke-opacity`) === undefined ? {} : { strokeOpacity: parseUnit(values.get("stroke-opacity"), ctx, `${path}/@stroke-opacity`)! }), ...(fillRule === undefined ? {} : { fillRule: fillRule as "nonzero" | "evenodd" }), ...(clipRule === undefined ? {} : { clipRule: clipRule as "nonzero" | "evenodd" }), ...(element && aria !== undefined ? { ariaHidden: aria === "true" } : {}) };
}

function parseTransforms(value: string | undefined, ctx: DiagnosticContext, location: string): readonly TransformOperationV2[] | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") fail(ctx, "XML_INVALID_TRANSFORM", "Transform cannot be empty.", location);
  const result: TransformOperationV2[] = [];
  let rest = value.trim();
  const number = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
  const pattern = new RegExp(`^(translate|scale|rotate)\\(\\s*(${number})(?:[\\t\\n\\r ]+(${number}))?(?:[\\t\\n\\r ]+(${number}))?\\s*\\)`);
  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (match === null) fail(ctx, "XML_INVALID_TRANSFORM", "Only exact translate, scale, and rotate forms are supported.", location);
    const values = match.slice(2).filter((item): item is string => item !== undefined).map((item) => parseNumberText(item, ctx, location));
    if (match[1] === "rotate") {
      if (values.length !== 1 && values.length !== 3) fail(ctx, "XML_INVALID_TRANSFORM", "rotate accepts angle or angle plus a complete pivot.", location);
      result.push({ type: "rotate", angle: values[0]!, ...(values.length === 3 ? { cx: values[1]!, cy: values[2]! } : {}) });
    } else {
      if (values.length > 2) fail(ctx, "XML_INVALID_TRANSFORM", `${match[1]} accepts one or two values.`, location);
      const type = match[1] as "translate" | "scale";
      const x = values[0]!;
      const y = values[1];
      result.push({ type, x, ...(y === undefined || y === (type === "translate" ? 0 : x) ? {} : { y }) });
    }
    rest = rest.slice(match[0].length);
    if (rest.length > 0) {
      const separator = /^[\t\n\r ]+/.exec(rest);
      if (separator === null) fail(ctx, "XML_INVALID_TRANSFORM", "Transform operations require whitespace separation.", location);
      rest = rest.slice(separator[0].length);
    }
  }
  return result;
}

function parsePoints(value: string, minimum: number, ctx: DiagnosticContext, location: string): readonly (readonly [number, number])[] {
  const tokens = value.trim().split(/[\t\n\r ,]+/).filter(Boolean);
  if (tokens.length % 2 !== 0) fail(ctx, "XML_INVALID_POINTS", "Point lists require x,y pairs.", location);
  const points: (readonly [number, number])[] = [];
  for (let index = 0; index < tokens.length; index += 2) points.push([parseNumberText(tokens[index]!, ctx, location), parseNumberText(tokens[index + 1]!, ctx, location)]);
  if (points.length < minimum) fail(ctx, "XML_INVALID_POINTS", `Expected at least ${minimum} point pairs.`, location);
  return points;
}

function parseElement(element: Element, ctx: DiagnosticContext, path: string, definition = false): ArtworkElementV2 {
  const localName = element.localName ?? element.tagName;
  const supported = ["path", "use", "circle", "ellipse", "rect", "line", "polyline", "polygon", "g"];
  if (!supported.includes(localName)) {
    const unsafe = ["script", "style", "image", "foreignObject", "animate", "animateTransform", "set"].includes(localName);
    fail(ctx, unsafe ? "XML_ACTIVE_CONTENT" : "XML_UNSUPPORTED_ELEMENT", `Unsupported SVG element '${element.tagName}'.`, path);
  }
  const geometry: Record<string, readonly string[]> = { path: ["d"], use: ["href", "x", "y"], circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"], rect: ["x", "y", "width", "height", "rx", "ry"], line: ["x1", "y1", "x2", "y2"], polyline: ["points"], polygon: ["points"], g: [] };
  const values = attributes(element, ["id", "transform", "aria-hidden", ...PRESENTATION_ATTRIBUTES, ...(geometry[localName] ?? [])], ctx, path);
  const id = values.get("id") === undefined ? undefined : parseLocalId(values.get("id"), ctx, `${path}/@id`);
  if (definition && id === undefined) fail(ctx, "XML_MISSING_ATTRIBUTE", "Definitions require id.", `${path}/@id`);
  const base = { ...parsePresentation(values, ctx, path, true), ...(id === undefined ? {} : { id }), ...(parseTransforms(values.get("transform"), ctx, `${path}/@transform`) === undefined ? {} : { transforms: parseTransforms(values.get("transform"), ctx, `${path}/@transform`)! }) };
  if (element.localName === "path") return { type: "path", ...base, d: parsePathData(required(values, "d", ctx, path), ctx, `${path}/@d`) };
  if (element.localName === "use") {
    const href = required(values, "href", ctx, path);
    if (!href.startsWith("#") || href.length === 1) fail(ctx, "XML_EXTERNAL_REFERENCE", "href must be an asset-local #id.", `${path}/@href`);
    return { type: "use", ...base, reference: parseLocalId(href.slice(1), ctx, `${path}/@href`), ...(values.get("x") === undefined ? {} : { x: parseNumberText(values.get("x")!, ctx, `${path}/@x`) }), ...(values.get("y") === undefined ? {} : { y: parseNumberText(values.get("y")!, ctx, `${path}/@y`) }) };
  }
  if (element.localName === "circle") { const r = parseNumberText(required(values, "r", ctx, path), ctx, `${path}/@r`); if (r <= 0) fail(ctx, "XML_INVALID_RANGE", "circle r must be positive.", `${path}/@r`); return { type: "circle", ...base, cx: parseNumberText(required(values, "cx", ctx, path), ctx, `${path}/@cx`), cy: parseNumberText(required(values, "cy", ctx, path), ctx, `${path}/@cy`), r }; }
  if (element.localName === "ellipse") { const rx = parseNumberText(required(values, "rx", ctx, path), ctx, `${path}/@rx`); const ry = parseNumberText(required(values, "ry", ctx, path), ctx, `${path}/@ry`); if (rx <= 0 || ry <= 0) fail(ctx, "XML_INVALID_RANGE", "ellipse radii must be positive.", path); return { type: "ellipse", ...base, cx: parseNumberText(required(values, "cx", ctx, path), ctx, `${path}/@cx`), cy: parseNumberText(required(values, "cy", ctx, path), ctx, `${path}/@cy`), rx, ry }; }
  if (element.localName === "rect") {
    const width = parseNumberText(required(values, "width", ctx, path), ctx, `${path}/@width`); const height = parseNumberText(required(values, "height", ctx, path), ctx, `${path}/@height`); if (width <= 0 || height <= 0) fail(ctx, "XML_INVALID_RANGE", "rect dimensions must be positive.", path);
    const rx = values.get("rx") === undefined ? undefined : parseNumberText(values.get("rx")!, ctx, `${path}/@rx`); const ry = values.get("ry") === undefined ? undefined : parseNumberText(values.get("ry")!, ctx, `${path}/@ry`); if ((rx === undefined) !== (ry === undefined)) fail(ctx, "XML_NORMALIZATION_REQUIRED", "Direct schema-2 source must declare both rx and ry.", path); if ((rx !== undefined && (rx < 0 || rx > width / 2)) || (ry !== undefined && (ry < 0 || ry > height / 2))) fail(ctx, "XML_INVALID_RANGE", "rect radii exceed SVG bounds.", path);
    return { type: "rect", ...base, x: parseNumberText(required(values, "x", ctx, path), ctx, `${path}/@x`), y: parseNumberText(required(values, "y", ctx, path), ctx, `${path}/@y`), width, height, ...(rx === undefined ? {} : rx === ry ? { cornerRadius: rx } : { cornerRadii: [rx, ry!] as const }) };
  }
  if (element.localName === "line") return { type: "line", ...base, x1: parseNumberText(required(values, "x1", ctx, path), ctx, `${path}/@x1`), y1: parseNumberText(required(values, "y1", ctx, path), ctx, `${path}/@y1`), x2: parseNumberText(required(values, "x2", ctx, path), ctx, `${path}/@x2`), y2: parseNumberText(required(values, "y2", ctx, path), ctx, `${path}/@y2`) };
  if (element.localName === "polyline" || element.localName === "polygon") return { type: element.localName, ...base, points: parsePoints(required(values, "points", ctx, path), element.localName === "polyline" ? 2 : 3, ctx, `${path}/@points`) };
  const children = childElements(element, ctx, path);
  if (children.length === 0) fail(ctx, "XML_INVALID_STRUCTURE", "Groups cannot be empty.", path);
  return { type: "group", ...base, children: children.map((child, index) => parseElement(child, ctx, `${path}/${child.localName}[${index}]`)) };
}

function parseGradient(element: Element, ctx: DiagnosticContext, path: string): LinearGradient {
  const values = attributes(element, ["id", "x1", "y1", "x2", "y2", "gradientUnits"], ctx, path);
  const units = values.get("gradientUnits"); if (units !== undefined && units !== "userSpaceOnUse") fail(ctx, "XML_INVALID_ENUM", "Only userSpaceOnUse is explicitly modeled.", `${path}/@gradientUnits`);
  const stops = childElements(element, ctx, path); if (stops.length < 2 || stops.some((stop) => stop.localName !== "stop")) fail(ctx, "XML_INVALID_STRUCTURE", "linearGradient requires at least two stops.", path);
  return { id: parseLocalId(required(values, "id", ctx, path), ctx, `${path}/@id`), x1: parseNumberText(required(values, "x1", ctx, path), ctx, `${path}/@x1`), y1: parseNumberText(required(values, "y1", ctx, path), ctx, `${path}/@y1`), x2: parseNumberText(required(values, "x2", ctx, path), ctx, `${path}/@x2`), y2: parseNumberText(required(values, "y2", ctx, path), ctx, `${path}/@y2`), ...(units === undefined ? {} : { units }), stops: stops.map((stop, index): GradientStop => { const attrs = attributes(stop, ["offset", "stop-color", "stop-opacity"], ctx, `${path}/stop[${index}]`); const offset = parseNumberText(required(attrs, "offset", ctx, path), ctx, `${path}/stop[${index}]/@offset`); const opacity = parseUnit(attrs.get("stop-opacity"), ctx, `${path}/stop[${index}]/@stop-opacity`); if (offset < 0 || offset > 1) fail(ctx, "XML_INVALID_RANGE", "Gradient offset must be in [0,1].", path); return { offset, color: parseHexColor(required(attrs, "stop-color", ctx, path), ctx, path), ...(opacity === undefined ? {} : { opacity }) }; }) };
}

function emptyDefinitions(): DefinitionsV2 { return { linearGradients: [], groups: [], paths: [], circles: [], ellipses: [], rects: [], lines: [], polylines: [], polygons: [] }; }
function parseDefinitions(element: Element, ctx: DiagnosticContext): DefinitionsV2 {
  attributes(element, [], ctx, "/svg/defs");
  const result = { linearGradients: [] as LinearGradient[], groups: [] as DefinitionsV2["groups"][number][], paths: [] as DefinitionsV2["paths"][number][], circles: [] as DefinitionsV2["circles"][number][], ellipses: [] as DefinitionsV2["ellipses"][number][], rects: [] as DefinitionsV2["rects"][number][], lines: [] as DefinitionsV2["lines"][number][], polylines: [] as DefinitionsV2["polylines"][number][], polygons: [] as DefinitionsV2["polygons"][number][] };
  const keyByType = { g: "groups", path: "paths", circle: "circles", ellipse: "ellipses", rect: "rects", line: "lines", polyline: "polylines", polygon: "polygons" } as const;
  for (const child of childElements(element, ctx, "/svg/defs")) {
    if (child.localName === "linearGradient") { result.linearGradients.push(parseGradient(child, ctx, "/svg/defs/linearGradient")); continue; }
    const key = keyByType[child.localName as keyof typeof keyByType]; if (key === undefined) fail(ctx, "XML_UNSUPPORTED_ELEMENT", `Unsupported defs element '${child.tagName}'.`, "/svg/defs");
    (result[key] as ArtworkElementV2[]).push(parseElement(child, ctx, `/svg/defs/${child.localName}`, true));
  }
  return result;
}

function decodeDocument(document: Document, ctx: DiagnosticContext): SvgDocumentV2 {
  const root = document.documentElement; if (root === null || root.localName !== "svg") fail(ctx, "XML_INVALID_ROOT", "Document root must be SVG.", "/");
  const rootAttrs = attributes(root, ["xmlns", "version", "width", "height", "viewBox", "role", "aria-labelledby", "aria-hidden", "aria-label", "focusable", "shape-rendering", ...PRESENTATION_ATTRIBUTES], ctx, "/svg");
  if (rootAttrs.get("xmlns") !== SVG_NAMESPACE) fail(ctx, "XML_UNSUPPORTED_NAMESPACE", "SVG root must declare the default namespace.", "/svg/@xmlns");
  const version = rootAttrs.get("version"); if (version !== undefined && version !== "1.0" && version !== "1.1") fail(ctx, "XML_UNSUPPORTED_VERSION", "Only SVG 1.0/1.1 markers are accepted.", "/svg/@version");
  const width = rootAttrs.get("width") === undefined ? undefined : parseNumberText(rootAttrs.get("width")!, ctx, "/svg/@width"); const height = rootAttrs.get("height") === undefined ? undefined : parseNumberText(rootAttrs.get("height")!, ctx, "/svg/@height"); if ((width !== undefined && width <= 0) || (height !== undefined && height <= 0)) fail(ctx, "XML_INVALID_RANGE", "SVG dimensions must be positive.", "/svg");
  const viewBoxValues = required(rootAttrs, "viewBox", ctx, "/svg").trim().split(/[\t\n\r ]+/); if (viewBoxValues.length !== 4) fail(ctx, "XML_INVALID_VIEW_BOX", "viewBox requires four numbers.", "/svg/@viewBox"); const viewBox = viewBoxValues.map((value) => parseNumberText(value, ctx, "/svg/@viewBox")) as [number, number, number, number]; if (viewBox[2] <= 0 || viewBox[3] <= 0) fail(ctx, "XML_INVALID_RANGE", "viewBox dimensions must be positive.", "/svg/@viewBox");
  const focusableRaw = rootAttrs.get("focusable"); if (focusableRaw !== undefined && focusableRaw !== "true" && focusableRaw !== "false") fail(ctx, "XML_INVALID_ENUM", "focusable must be true or false.", "/svg/@focusable"); const focusable = focusableRaw === undefined ? undefined : focusableRaw === "true";
  const shape = rootAttrs.get("shape-rendering"); if (shape !== undefined && !["auto", "optimizeSpeed", "crispEdges", "geometricPrecision"].includes(shape)) fail(ctx, "XML_INVALID_ENUM", "Unsupported shape-rendering.", "/svg/@shape-rendering");
  const children = childElements(root, ctx, "/svg"); let cursor = 0; let accessibility;
  if (rootAttrs.get("aria-hidden") === "true") { if (rootAttrs.get("role") !== undefined || rootAttrs.get("aria-labelledby") !== undefined || rootAttrs.get("aria-label") !== undefined) fail(ctx, "XML_INVALID_ACCESSIBILITY", "Decorative SVG has conflicting accessibility attributes.", "/svg"); accessibility = { mode: "decorative", ...(focusable === undefined ? {} : { focusable }) } as const; }
  else if (rootAttrs.get("role") === "img" && rootAttrs.get("aria-labelledby") === undefined) { if (rootAttrs.get("aria-label") !== undefined || rootAttrs.get("aria-hidden") !== undefined) fail(ctx, "XML_INVALID_ACCESSIBILITY", "Consumer-labelled SVG has conflicting accessibility attributes.", "/svg"); accessibility = { mode: "consumer_labelled", ...(focusable === undefined ? {} : { focusable }) } as const; }
  else if (rootAttrs.get("role") === "img" && rootAttrs.get("aria-labelledby") !== undefined) { const titleElement = children[cursor]; if (titleElement?.localName !== "title") fail(ctx, "XML_INVALID_ACCESSIBILITY", "Labelled SVG must begin with title.", "/svg"); cursor += 1; const titleAttrs = attributes(titleElement, ["id"], ctx, "/svg/title"); const titleId = parseLocalId(required(titleAttrs, "id", ctx, "/svg/title"), ctx, "/svg/title/@id"); const title = textOnly(titleElement, ctx, "/svg/title"); if (title === "") fail(ctx, "XML_INVALID_ACCESSIBILITY", "Title cannot be empty.", "/svg/title"); let description: string | undefined; let descriptionId: import("./types.js").LocalId | undefined; if (children[cursor]?.localName === "desc") { const desc = children[cursor]!; cursor += 1; const attrs = attributes(desc, ["id"], ctx, "/svg/desc"); descriptionId = parseLocalId(required(attrs, "id", ctx, "/svg/desc"), ctx, "/svg/desc/@id"); description = textOnly(desc, ctx, "/svg/desc"); if (description === "") fail(ctx, "XML_INVALID_ACCESSIBILITY", "Description cannot be empty.", "/svg/desc"); } const expected = descriptionId === undefined ? `${titleId}` : `${titleId} ${descriptionId}`; if (rootAttrs.get("aria-labelledby") !== expected) fail(ctx, "XML_INVALID_ACCESSIBILITY", "aria-labelledby must exactly name title then optional desc.", "/svg/@aria-labelledby"); accessibility = { mode: "labelled", title, titleId, ...(description === undefined || descriptionId === undefined ? {} : { description, descriptionId }), ...(focusable === undefined ? {} : { focusable }) } as const; }
  else fail(ctx, "XML_INVALID_ACCESSIBILITY", "SVG must declare one schema-2 accessibility mode.", "/svg");
  let metadataText: string | undefined; if (children[cursor]?.localName === "metadata") { const metadata = children[cursor++]!; attributes(metadata, [], ctx, "/svg/metadata"); metadataText = textOnly(metadata, ctx, "/svg/metadata"); }
  let definitions = emptyDefinitions(); if (children[cursor]?.localName === "defs") definitions = parseDefinitions(children[cursor++]!, ctx);
  const artwork = children.slice(cursor); if (artwork.length === 0) fail(ctx, "XML_INVALID_STRUCTURE", "SVG requires artwork.", "/svg");
  const svg: SvgDocumentV2 = { canvas: { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }), viewBox, ...(shape === undefined || shape === "auto" ? {} : { shapeRendering: shape as ShapeRendering }) }, accessibility, presentation: parsePresentation(rootAttrs, ctx, "/svg", false) as PresentationV2, ...(metadataText === undefined ? {} : { metadataText }), definitions, elements: artwork.map((element, index) => parseElement(element, ctx, `/svg/${element.localName}[${index}]`)) };
  validateSvgDocumentV2(svg, ctx); return svg;
}

export function parseSvgV2(text: string, source?: string): Result<SvgDocumentV2> {
  const ctx = context(source);
  try { const normalized = text.replace(/^\uFEFF/, ""); preflightXml(normalized, ctx); const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(normalized, MIME_TYPE.XML_APPLICATION); return ok(decodeDocument(document, ctx)); }
  catch (error) { return fromCaught(error, ctx, "XML_SYNTAX", "Invalid or malformed XML.", (caught) => caught instanceof ParseError); }
}

function escapeText(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escapeAttribute(value: string): string { return escapeText(value).replace(/"/g, "&quot;"); }
function attribute(name: string, value: string | number | undefined): string { if (value === undefined) return ""; return ` ${name}="${escapeAttribute(typeof value === "number" ? formatNumber(value) : value)}"`; }
function paint(paintValue: PaintV2): string { if (paintValue.type === "solid") return paintValue.color; if (paintValue.type === "linear-gradient") return `url(#${paintValue.reference})${paintValue.fallback === undefined ? "" : ` ${paintValue.fallback}`}`; return paintValue.type; }
function presentationAttributes(value: ElementPresentationV2, element = true): string { return [value.fill === undefined ? "" : attribute("fill", paint(value.fill)), value.stroke === undefined ? "" : attribute("stroke", paint(value.stroke)), attribute("stroke-width", value.strokeWidth), attribute("stroke-linecap", value.strokeLinecap), attribute("stroke-linejoin", value.strokeLinejoin), attribute("stroke-miterlimit", value.strokeMiterlimit), attribute("opacity", value.opacity), element ? attribute("aria-hidden", value.ariaHidden === undefined ? undefined : value.ariaHidden ? "true" : "false") : "", attribute("fill-opacity", value.fillOpacity), attribute("stroke-opacity", value.strokeOpacity), attribute("fill-rule", value.fillRule), attribute("clip-rule", value.clipRule)].join(""); }
function transforms(value: readonly TransformOperationV2[] | undefined): string | undefined { return value?.map((item) => item.type === "rotate" ? `rotate(${formatNumber(item.angle)}${item.cx === undefined ? "" : ` ${formatNumber(item.cx)} ${formatNumber(item.cy!)}`})` : `${item.type}(${formatNumber(item.x)}${item.y === undefined ? "" : ` ${formatNumber(item.y)}`})`).join(" "); }
function renderElement(value: ArtworkElementV2, depth: number): readonly string[] { const indent = "  ".repeat(depth); const common = `${attribute("id", value.id)}${value.type === "use" ? attribute("href", `#${value.reference}`) + attribute("x", value.x) + attribute("y", value.y) : ""}${presentationAttributes(value)}${attribute("transform", transforms(value.transforms))}`; if (value.type === "group") return [`${indent}<g${common}>`, ...value.children.flatMap((child) => renderElement(child, depth + 1)), `${indent}</g>`]; let geometry = ""; if (value.type === "path") geometry = attribute("d", value.d); else if (value.type === "circle") geometry = attribute("cx", value.cx) + attribute("cy", value.cy) + attribute("r", value.r); else if (value.type === "ellipse") geometry = attribute("cx", value.cx) + attribute("cy", value.cy) + attribute("rx", value.rx) + attribute("ry", value.ry); else if (value.type === "rect") { const rx = value.cornerRadius ?? value.cornerRadii?.[0]; const ry = value.cornerRadius ?? value.cornerRadii?.[1]; geometry = attribute("x", value.x) + attribute("y", value.y) + attribute("width", value.width) + attribute("height", value.height) + attribute("rx", rx) + attribute("ry", ry); } else if (value.type === "line") geometry = attribute("x1", value.x1) + attribute("y1", value.y1) + attribute("x2", value.x2) + attribute("y2", value.y2); else if (value.type === "polyline" || value.type === "polygon") geometry = attribute("points", value.points.map((point) => `${formatNumber(point[0])},${formatNumber(point[1])}`).join(" ")); return [`${indent}<${value.type}${common}${geometry}/>`]; }
function textElement(tag: string, id: string | undefined, value: string, depth: number): readonly string[] { const indent = "  ".repeat(depth); if (!value.includes("\n")) return [`${indent}<${tag}${attribute("id", id)}>${escapeText(value)}</${tag}>`]; return [`${indent}<${tag}${attribute("id", id)}>`, ...value.split("\n").map((line) => `${"  ".repeat(depth + 1)}${escapeText(line)}`), `${indent}</${tag}>`]; }
function renderGradient(value: LinearGradient, depth: number): readonly string[] { const indent = "  ".repeat(depth); return [`${indent}<linearGradient${attribute("id", value.id)}${attribute("x1", value.x1)}${attribute("y1", value.y1)}${attribute("x2", value.x2)}${attribute("y2", value.y2)}${attribute("gradientUnits", value.units)}>`, ...value.stops.map((stop) => `${"  ".repeat(depth + 1)}<stop${attribute("offset", stop.offset)}${attribute("stop-color", stop.color)}${attribute("stop-opacity", stop.opacity)}/>`), `${indent}</linearGradient>`]; }
function renderSvgV2(svg: SvgDocumentV2): string { const access = svg.accessibility; const rootAccessibility = access.mode === "labelled" ? attribute("role", "img") + attribute("aria-labelledby", `${access.titleId}${access.descriptionId === undefined ? "" : ` ${access.descriptionId}`}`) : access.mode === "decorative" ? attribute("aria-hidden", "true") : attribute("role", "img"); const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<svg${attribute("xmlns", SVG_NAMESPACE)}${attribute("width", svg.canvas.width)}${attribute("height", svg.canvas.height)}${attribute("viewBox", svg.canvas.viewBox.map(formatNumber).join(" "))}${rootAccessibility}${attribute("focusable", access.focusable === undefined ? undefined : access.focusable ? "true" : "false")}${attribute("shape-rendering", svg.canvas.shapeRendering)}${presentationAttributes(svg.presentation, false)}>`]; if (access.mode === "labelled") { lines.push(...textElement("title", access.titleId, access.title, 1)); if (access.description !== undefined) lines.push(...textElement("desc", access.descriptionId, access.description, 1)); } if (svg.metadataText !== undefined) lines.push(...textElement("metadata", undefined, svg.metadataText, 1)); const definitions = svg.definitions; if (definitions.linearGradients.length + definitions.groups.length + definitions.paths.length + definitions.circles.length + definitions.ellipses.length + definitions.rects.length + definitions.lines.length + definitions.polylines.length + definitions.polygons.length > 0) { lines.push("  <defs>"); for (const gradient of definitions.linearGradients) lines.push(...renderGradient(gradient, 2)); for (const collection of [definitions.groups, definitions.paths, definitions.circles, definitions.ellipses, definitions.rects, definitions.lines, definitions.polylines, definitions.polygons]) for (const definition of collection) lines.push(...renderElement(definition, 2)); lines.push("  </defs>"); } for (const element of svg.elements) lines.push(...renderElement(element, 1)); lines.push("</svg>"); return `${lines.join("\n")}\n`; }

export function serializeSvgV2(svg: SvgDocumentV2, source?: string): Result<string>;
export function serializeSvgV2(svg: SvgDocument, source?: string): Result<string>;
export function serializeSvgV2(svg: SvgDocumentV2 | SvgDocument, source?: string): Result<string> {
  if (!("mode" in svg.accessibility)) return serializeSvg(svg as SvgDocument, source);
  const ctx = context(source, "serialize");
  const schema2 = svg as SvgDocumentV2;
  try { validateSvgDocumentV2(schema2, ctx); return ok(renderSvgV2(schema2)); }
  catch (error) { if (error instanceof DiagnosticError) return { ok: false, diagnostics: [error.diagnostic] }; throw error; }
}

export function assetFromSvgV2(id: NormalizedAssetV2["id"], filename: NormalizedAssetV2["filename"], svg: SvgDocumentV2): NormalizedAssetV2 { return { schemaVersion: 2, id, filename, svg }; }
