import { DOMParser, type Element } from "@xmldom/xmldom";

import { parseSvg } from "./svg.js";
import { isLocalId, parsePathData } from "./primitives.js";
import {
  ANALYZE_COMMON_V03_PROFILE,
  ANALYZE_FEATURE_CODE_REGISTRY,
  ANALYZE_LIMITS,
  ANALYZE_SCHEMA1_PROFILE,
  type AnalyzeCode,
  type AnalyzeDetailsFile,
  type AnalyzeFeatureCode,
  type AnalyzeNormalization,
  type CommonV03Classification,
  type Schema1Classification,
} from "./analyze-contract.js";
import { compareUtf8 } from "./provenance.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const LOCAL_GRADIENT_PAINT = /^url\(#([^)]+)\)(?:[\t\n\r ]+(#[0-9A-Fa-f]{6}))?$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SUPPORTED_ELEMENTS = new Set(["svg", "title", "desc", "metadata", "defs", "linearGradient", "stop", "path", "g", "use", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const ARTWORK_ELEMENTS = new Set(["path", "g", "use", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const DEFINITION_ELEMENTS = new Set(["path", "g", "circle", "ellipse", "rect", "line", "polyline", "polygon", "linearGradient"]);
const PRIMITIVES = new Set(["circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const ACTIVE_ELEMENTS = new Set(["script", "style", "image", "foreignObject", "animate", "animateColor", "animateMotion", "animateTransform", "set", "iframe", "object", "embed", "audio", "video"]);
const UNSUPPORTED_ELEMENTS = new Set(["clipPath", "mask", "filter", "marker", "pattern", "symbol", "text", "tspan", "radialGradient"]);
const PRESENTATION = new Set(["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule", "aria-hidden"]);
const ROOT_ATTRIBUTES = new Set(["xmlns", "xmlns:xlink", "version", "width", "height", "viewBox", "role", "aria-labelledby", "aria-hidden", "aria-label", "focusable", "shape-rendering"]);
const ELEMENT_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  title: new Set(["id"]), desc: new Set(["id"]), metadata: new Set(), defs: new Set(),
  linearGradient: new Set(["id", "x1", "y1", "x2", "y2", "gradientUnits"]),
  stop: new Set(["offset", "stop-color", "stop-opacity"]),
  path: new Set(["id", "d", "transform"]), g: new Set(["id", "transform"]),
  use: new Set(["id", "href", "x", "y", "transform"]),
  circle: new Set(["id", "cx", "cy", "r", "transform"]), ellipse: new Set(["id", "cx", "cy", "rx", "ry", "transform"]),
  rect: new Set(["id", "x", "y", "width", "height", "rx", "ry", "transform"]),
  line: new Set(["id", "x1", "y1", "x2", "y2", "transform"]),
  polyline: new Set(["id", "points", "transform"]), polygon: new Set(["id", "points", "transform"]),
};
const FEATURE_CODES = new Set<string>(ANALYZE_FEATURE_CODE_REGISTRY);

interface Finding { readonly code: AnalyzeCode; readonly location: string; }
interface Inventory {
  readonly features: Set<AnalyzeFeatureCode>; readonly unsafe: Map<AnalyzeCode, string>;
  readonly unsupported: Map<AnalyzeCode, string>; readonly normalizations: Set<AnalyzeNormalization>;
  readonly xmlElements: number; readonly modeledElements: number; readonly maxGroupDepth: number;
  readonly text: string | null; readonly validUtf8: boolean; readonly canModel: boolean;
  requiresCanonicalWhitespaceNormalization: boolean;
}

function addFinding(target: Map<AnalyzeCode, string>, code: AnalyzeCode, location: string): void { if (!target.has(code)) target.set(code, location); }
function addFeature(target: Set<AnalyzeFeatureCode>, code: string): void {
  if (!FEATURE_CODES.has(code)) throw new Error("Analyze feature registry is incomplete.");
  target.add(code as AnalyzeFeatureCode);
}
function elementFeature(name: string): AnalyzeFeatureCode {
  const mapped = ACTIVE_ELEMENTS.has(name) ? (name.startsWith("animate") || name === "set" ? "element.animation" : `element.${name}`) : SUPPORTED_ELEMENTS.has(name) || UNSUPPORTED_ELEMENTS.has(name) ? `element.${name}` : "element.other";
  return FEATURE_CODES.has(mapped) ? mapped as AnalyzeFeatureCode : "element.other";
}
function localName(name: string): string { return name.includes(":") ? name.slice(name.indexOf(":") + 1) : name; }
function locationFor(name: string, attribute?: string): string {
  const element = FEATURE_CODES.has(`element.${name}`) ? name : "other";
  const base = element === "clipPath" ? "/svg/defs/clipPath" : `/svg/${element}`;
  return attribute === undefined ? base : `${base}/@${attribute.replace(/[^A-Za-z0-9_.:-]/g, "-")}`;
}
function isExternal(value: string): boolean {
  const text = value.trim();
  if (text.startsWith("#") || /^url\(\s*#[^)]+\s*\)$/i.test(text)) return false;
  return /^(?:data:|\/\/|[A-Za-z][A-Za-z0-9+.-]*:|\/)/.test(text) || /url\s*\(\s*(?!#)/i.test(text);
}
function numeric(value: string | null): boolean { return value !== null && NUMBER.test(value.trim()) && Number.isFinite(Number(value)); }
function children(element: Element): Element[] { const result: Element[] = []; for (let index = 0; index < element.childNodes.length; index += 1) { const node = element.childNodes.item(index); if (node?.nodeType === 1) result.push(node as Element); } return result; }
function directText(element: Element): string { let result = ""; for (let index = 0; index < element.childNodes.length; index += 1) { const node = element.childNodes.item(index); if (node?.nodeType === 3) result += node.nodeValue ?? ""; } return result.replace(/[\t\n\r ]+/g, " ").trim(); }
function hasNoncanonicalAsciiWhitespace(value: string): boolean { return /[\t\n\r]| {2,}/.test(value); }

function inventoryTokens(bytes: Uint8Array): Inventory {
  let text: string | null = null;
  let validUtf8 = true;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { validUtf8 = false; text = Buffer.from(bytes).toString("latin1"); }
  const features = new Set<AnalyzeFeatureCode>();
  const unsafe = new Map<AnalyzeCode, string>();
  const unsupported = new Map<AnalyzeCode, string>();
  const normalizations = new Set<AnalyzeNormalization>();
  let requiresCanonicalWhitespaceNormalization = false;
  if (!validUtf8) addFinding(unsupported, "ANALYZE_INVALID_UTF8", "/svg");
  if (/<!--/.test(text)) addFeature(features, "xml.comment");
  if (/<!\[CDATA\[/i.test(text)) { addFeature(features, "xml.cdata"); addFinding(unsupported, "ANALYZE_UNSUPPORTED_XML_NODE", "/svg"); }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) { addFeature(features, "xml.doctype"); addFinding(unsafe, "ANALYZE_UNSAFE_XML_DECLARATION", "/svg"); }
  const declarations = [...text.matchAll(/<\?xml\b[^?]*(?:\?(?!>)|[^?])*\?>/gi)];
  if (declarations.length > 0) addFeature(features, "xml.declaration");
  const leading = /^\uFEFF?\s*<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])UTF-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/i.test(text);
  if (declarations.length > 1 || (declarations.length === 1 && !leading)) addFinding(unsafe, "ANALYZE_UNSAFE_XML_DECLARATION", "/svg");
  const withoutLeadingDeclaration = text.replace(/^\uFEFF?\s*<\?xml\b[^?]*(?:\?(?!>)|[^?])*\?>/i, "");
  if (/<\?(?!xml\b)/i.test(withoutLeadingDeclaration) || /<\?xml\b/i.test(withoutLeadingDeclaration)) { addFeature(features, "xml.processing-instruction"); addFinding(unsupported, "ANALYZE_UNSUPPORTED_XML_NODE", "/svg"); }
  if (/<\?xml-stylesheet\b/i.test(text)) addFinding(unsafe, "ANALYZE_UNSAFE_EXTERNAL_REFERENCE", "/svg");

  const tokenText = text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/gi, "");
  let xmlElements = 0;
  let modeledElements = 0;
  let groupDepth = 0;
  let maxGroupDepth = 0;
  const tagPattern = /<\s*(\/?)\s*([_:A-Za-z\p{L}][\p{L}\p{N}_.:-]*)([^<>]*?)(\/?)\s*>/gu;
  for (const match of tokenText.matchAll(tagPattern)) {
    const closing = match[1] === "/";
    const qname = match[2] ?? "";
    const name = localName(qname);
    const tail = match[3] ?? "";
    const selfClosing = match[4] === "/";
    if (closing) { if (name === "g") groupDepth = Math.max(0, groupDepth - 1); continue; }
    xmlElements += 1;
    addFeature(features, elementFeature(name));
    if (ARTWORK_ELEMENTS.has(name) || name === "linearGradient" || name === "stop") modeledElements += 1;
    if (name === "g") { groupDepth += 1; maxGroupDepth = Math.max(maxGroupDepth, groupDepth); }
    if (ACTIVE_ELEMENTS.has(name)) addFinding(unsafe, "ANALYZE_UNSAFE_ACTIVE_ELEMENT", locationFor(name));
    else if (!SUPPORTED_ELEMENTS.has(name)) addFinding(unsupported, "ANALYZE_UNSUPPORTED_ELEMENT", locationFor(name));
    if (qname.includes(":")) { addFeature(features, "namespace.other"); addFinding(unsupported, "ANALYZE_UNSUPPORTED_NAMESPACE", locationFor(name)); }
    const attrPattern = /([^\s=]+)\s*=\s*(["'])(.*?)\2/gs;
    for (const attribute of tail.matchAll(attrPattern)) {
      const rawName = attribute[1] ?? "";
      const attrName = localName(rawName);
      const value = attribute[3] ?? "";
      const location = locationFor(name, rawName);
      if (["viewBox", "d", "transform", "points"].includes(rawName) && hasNoncanonicalAsciiWhitespace(value)) requiresCanonicalWhitespaceNormalization = true;
      if (["fill", "stroke"].includes(rawName)) {
        if (value !== value.trim() || hasNoncanonicalAsciiWhitespace(value)) requiresCanonicalWhitespaceNormalization = true;
        const paint = /^url\(#[^)]+\)([\t\n\r ]+)#[0-9A-Fa-f]{6}$/.exec(value);
        if (paint?.[1] !== undefined && paint[1] !== " ") requiresCanonicalWhitespaceNormalization = true;
      }
      if (/^on/i.test(rawName)) { addFeature(features, "attribute.event"); addFinding(unsafe, "ANALYZE_UNSAFE_ACTIVE_ATTRIBUTE", location); }
      if (rawName === "style") { addFeature(features, "attribute.style"); addFinding(unsafe, "ANALYZE_UNSAFE_ACTIVE_ATTRIBUTE", location); }
      if (rawName === "class") { addFeature(features, "attribute.class"); addFinding(unsupported, "ANALYZE_UNSUPPORTED_CSS_CLASS", location); }
      if (rawName === "clip-path") addFeature(features, "attribute.clip-path");
      if (rawName === "href") addFeature(features, "attribute.href");
      if (rawName === "xlink:href") { addFeature(features, "attribute.xlink-href"); addFeature(features, "reference.xlink_local"); normalizations.add("xlink_href_to_href"); }
      if (rawName === "xmlns:xlink") { addFeature(features, "namespace.xlink"); normalizations.add("xlink_namespace_to_svg2_href"); }
      if ((attrName === "href" || attrName === "src" || rawName === "fill" || rawName === "stroke" || rawName === "clip-path" || rawName === "style") && isExternal(value)) { addFeature(features, "reference.external"); addFinding(unsafe, "ANALYZE_UNSAFE_EXTERNAL_REFERENCE", location); }
      if ((attrName === "href" || /url\(/i.test(value)) && !isExternal(value)) addFeature(features, "reference.local");
      if ((rawName === "fill" || rawName === "stroke") && value.trim() === "currentColor") addFeature(features, "paint.currentColor");
      if (rawName === "transform") for (const transform of value.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*\(/g)) { const code = `transform.${transform[1] ?? "unknown"}`; addFeature(features, FEATURE_CODES.has(code) ? code : "transform.unknown"); }
      if (name === "svg" && PRESENTATION.has(rawName) && rawName !== "aria-hidden") { const code = `root-presentation.${rawName}`; if (FEATURE_CODES.has(code)) addFeature(features, code); normalizations.add("promote_root_presentation"); }
      else if (["opacity", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule"].includes(rawName)) { const code = `presentation.${rawName}`; if (FEATURE_CODES.has(code)) addFeature(features, code); }
    }
    if (name === "g" && selfClosing) groupDepth = Math.max(0, groupDepth - 1);
  }
  if (bytes.byteLength > ANALYZE_LIMITS.fileBytes) addFinding(unsupported, "ANALYZE_FILE_BYTE_LIMIT_EXCEEDED", "/svg");
  if (xmlElements > ANALYZE_LIMITS.fileXmlElements) addFinding(unsupported, "ANALYZE_FILE_ELEMENT_LIMIT_EXCEEDED", "/svg");
  if (modeledElements > ANALYZE_LIMITS.modeledElements) addFinding(unsupported, "ANALYZE_PROFILE_ELEMENT_LIMIT_EXCEEDED", "/svg");
  if (maxGroupDepth > ANALYZE_LIMITS.groupDepth) addFinding(unsupported, "ANALYZE_PROFILE_DEPTH_LIMIT_EXCEEDED", "/svg");
  return { features, unsafe, unsupported, normalizations, xmlElements, modeledElements, maxGroupDepth, text: validUtf8 ? text : null, validUtf8, canModel: validUtf8 && bytes.byteLength <= ANALYZE_LIMITS.fileBytes && xmlElements <= ANALYZE_LIMITS.fileXmlElements && !unsafe.has("ANALYZE_UNSAFE_XML_DECLARATION"), requiresCanonicalWhitespaceNormalization };
}

function inspectPaint(value: string, unsupported: Map<AnalyzeCode, string>, features: Set<AnalyzeFeatureCode>, location: string): string | null {
  const text = value.trim();
  if (text === "none") {
    addFeature(features, "paint.none");
    return null;
  }
  if (text === "currentColor") {
    addFeature(features, "paint.currentColor");
    return null;
  }
  if (/^#[0-9A-Fa-f]{6}$/.test(text)) {
    addFeature(features, "paint.hex");
    return null;
  }
  const localGradient = text.match(LOCAL_GRADIENT_PAINT);
  const target = localGradient?.[1];
  if (target !== undefined && isLocalId(target)) {
    addFeature(features, "paint.linearGradient");
    return target;
  }
  if (target !== undefined) addFinding(unsupported, "ANALYZE_INVALID_REFERENCE", location);
  if (isExternal(text)) addFeature(features, "paint.external");
  else addFeature(features, "paint.other");
  addFinding(unsupported, "ANALYZE_UNSUPPORTED_PAINT", location);
  return null;
}

function inspectTransform(value: string, unsupported: Map<AnalyzeCode, string>, features: Set<AnalyzeFeatureCode>, location: string): void {
  const pattern = /([A-Za-z][A-Za-z0-9]*)\s*\(([^)]*)\)/g;
  let cursor = 0;
  let found = false;
  for (const match of value.matchAll(pattern)) {
    found = true;
    if (value.slice(cursor, match.index).trim() !== "") addFinding(unsupported, "ANALYZE_UNSUPPORTED_TRANSFORM", location);
    cursor = (match.index ?? 0) + match[0].length;
    const name = match[1] ?? "";
    const args = (match[2] ?? "").trim().split(/[\s,]+/).filter(Boolean);
    const validNumbers = args.every((part) => numeric(part));
    const validArity = name === "translate" || name === "scale" ? args.length === 1 || args.length === 2 : name === "rotate" ? args.length === 1 || args.length === 3 : false;
    if (!["translate", "scale", "rotate"].includes(name) || !validNumbers || !validArity) addFinding(unsupported, "ANALYZE_UNSUPPORTED_TRANSFORM", location);
    const code = `transform.${name}`; addFeature(features, FEATURE_CODES.has(code) ? code : "transform.unknown");
  }
  if (!found || value.slice(cursor).trim() !== "") addFinding(unsupported, "ANALYZE_UNSUPPORTED_TRANSFORM", location);
}

function inspectDom(root: Element, inventory: Inventory): void {
  const { features, unsafe, unsupported, normalizations } = inventory;
  if (root.localName !== "svg") { addFinding(unsupported, "ANALYZE_INVALID_ROOT", "/svg"); return; }
  addFeature(features, "namespace.svg");
  if (root.namespaceURI !== SVG_NS || (root.prefix !== null && root.prefix !== "")) addFinding(unsupported, "ANALYZE_UNSUPPORTED_NAMESPACE", "/svg");
  const viewBox = (root.getAttribute("viewBox") ?? "").trim().split(/[\t\n\r ]+/).filter(Boolean);
  if (viewBox.length !== 4 || viewBox.some((value) => !numeric(value)) || Number(viewBox[2]) <= 0 || Number(viewBox[3]) <= 0) addFinding(unsupported, "ANALYZE_INVALID_VIEWBOX", "/svg/@viewBox");
  for (const field of ["width", "height"]) if (root.hasAttribute(field) && (!numeric(root.getAttribute(field)) || Number(root.getAttribute(field)) <= 0)) addFinding(unsupported, "ANALYZE_INVALID_CANVAS_DIMENSION", `/svg/@${field}`);
  const shapeRendering = root.getAttribute("shape-rendering") ?? "";
  if (shapeRendering !== "" && !["auto", "optimizeSpeed", "crispEdges", "geometricPrecision"].includes(shapeRendering)) addFinding(unsupported, "ANALYZE_INVALID_SHAPE_RENDERING", "/svg/@shape-rendering");
  const directChildren = children(root);
  const titles = directChildren.filter((item) => item.localName === "title");
  const descriptions = directChildren.filter((item) => item.localName === "desc");
  const title = titles[0]; const description = descriptions[0];
  const hasTitle = title !== undefined && directText(title) !== "";
  const hasDescription = description !== undefined && directText(description) !== "";
  const hidden = root.getAttribute("aria-hidden") ?? "";
  const role = root.getAttribute("role") ?? "";
  const labelledBy = (root.getAttribute("aria-labelledby") ?? "").trim();
  if (titles.length > 1 || descriptions.length > 1 || !["", "img"].includes(role) || !["", "true", "false"].includes(hidden) || root.hasAttribute("aria-label") || ((hasTitle || hasDescription) && hidden === "true")) addFinding(unsupported, "ANALYZE_INVALID_ACCESSIBILITY", "/svg");
  const titleId = title?.getAttribute("id") ?? ""; const descriptionId = description?.getAttribute("id") ?? "";
  const exactLabelled = role === "img" && hasTitle && (!hasDescription || description !== undefined) && isLocalId(titleId) && (!hasDescription || isLocalId(descriptionId)) && labelledBy === (hasDescription ? `${titleId} ${descriptionId}` : titleId) && hidden === "";
  if (exactLabelled) addFeature(features, "accessibility.labelled");
  else if (hidden === "true" && !hasTitle && !hasDescription && role === "") { addFeature(features, "accessibility.decorative"); normalizations.add("declare_decorative"); }
  else if (role === "img" && !hasTitle && !hasDescription && hidden === "" && labelledBy === "") addFeature(features, "accessibility.consumer_labelled");
  else if (hasTitle && hidden !== "true") { addFeature(features, "accessibility.labelled"); normalizations.add(hasDescription ? "labelled_ids_and_references" : "title_only_to_labelled"); }
  else if (!hasTitle && !hasDescription) { addFeature(features, "accessibility.unlabelled"); normalizations.add("accessibility_authority_required"); }

  const ids = new Map<string, string>();
  const references: { readonly target: string; readonly owner: string | null }[] = [];
  const paintReferences: string[] = [];
  const definitions = new Map<string, string>();
  let artwork = 0;
  let firstArtwork = -1; let defsIndex = -1;
  directChildren.forEach((child, index) => { if (child.localName === "defs" && defsIndex < 0) defsIndex = index; if (ARTWORK_ELEMENTS.has(child.localName ?? "") && firstArtwork < 0) firstArtwork = index; });
  if (defsIndex >= 0 && firstArtwork >= 0 && defsIndex > firstArtwork) { addFeature(features, "definitions.forward_order"); normalizations.add("canonicalize_definition_order"); }
  const visit = (element: Element, parent: string, insideDefs: boolean, ownerDefinition: string | null): void => {
    const name = element.localName ?? element.tagName;
    if (["title", "desc", "metadata", "defs"].includes(name) && parent !== "svg") addFinding(unsupported, "ANALYZE_UNSUPPORTED_ELEMENT", locationFor(name));
    if (name === "linearGradient" && parent !== "defs") addFinding(unsupported, "ANALYZE_UNSUPPORTED_ELEMENT", locationFor(name));
    if (name === "stop" && parent !== "linearGradient") addFinding(unsupported, "ANALYZE_UNSUPPORTED_ELEMENT", locationFor(name));
    if (parent === "defs") {
      if (PRIMITIVES.has(name)) addFeature(features, "definition.basic_geometry");
      else if (name === "g") addFeature(features, "definition.group");
      else if (name === "path") addFeature(features, "definition.path");
      else if (name === "linearGradient") addFeature(features, "definition.linearGradient");
      if (!DEFINITION_ELEMENTS.has(name)) addFinding(unsupported, "ANALYZE_UNSUPPORTED_ELEMENT", locationFor(name));
    }
    if (ARTWORK_ELEMENTS.has(name) && !insideDefs) artwork += 1;
    let currentOwner = ownerDefinition;
    if (element.hasAttribute("id")) { const id = element.getAttribute("id") ?? ""; if (!isLocalId(id) || ids.has(id)) addFinding(unsupported, "ANALYZE_INVALID_ID", locationFor(name, "id")); else { ids.set(id, name); if (insideDefs && DEFINITION_ELEMENTS.has(name)) { definitions.set(id, name); currentOwner = id; } } }
    if (element.namespaceURI !== SVG_NS || (element.prefix !== null && element.prefix !== "")) addFinding(unsupported, "ANALYZE_UNSUPPORTED_NAMESPACE", locationFor(name));
    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index); if (attribute === null) continue;
      const attr = attribute.name; const local = attribute.localName ?? attr; const location = locationFor(name, attr);
      if ((local === "href" || local === "src" || attr === "fill" || attr === "stroke" || attr === "clip-path" || attr === "style") && isExternal(attribute.value)) addFinding(unsafe, "ANALYZE_UNSAFE_EXTERNAL_REFERENCE", location);
      if (attribute.namespaceURI === XMLNS_NS || attr === "xmlns") {
        if (attr === "xmlns" && attribute.value === SVG_NS) continue;
        if (attr === "xmlns:xlink" && attribute.value === XLINK_NS) continue;
        addFinding(unsupported, "ANALYZE_UNSUPPORTED_NAMESPACE", location); continue;
      }
      if (attribute.namespaceURI === XLINK_NS && local === "href" && name === "use") continue;
      if (attribute.namespaceURI !== null && attribute.namespaceURI !== "") { addFinding(unsupported, "ANALYZE_UNSUPPORTED_NAMESPACE", location); continue; }
      if (/^on/i.test(attr) || attr === "style") continue;
      if (attr === "class") continue;
      if (attr === "id" && name !== "svg") continue;
      const allowed = name === "svg" ? ROOT_ATTRIBUTES : ELEMENT_ATTRIBUTES[name];
      if (allowed?.has(attr) || PRESENTATION.has(attr)) {
        if ((attr === "fill" || attr === "stroke")) {
          const localPaintTarget = inspectPaint(attribute.value, unsupported, features, location);
          if (localPaintTarget !== null) paintReferences.push(localPaintTarget);
        }
        if (["opacity", "fill-opacity", "stroke-opacity"].includes(attr) && (!numeric(attribute.value) || Number(attribute.value) < 0 || Number(attribute.value) > 1)) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", location);
        if (attr === "stroke-width" && (!numeric(attribute.value) || Number(attribute.value) < 0)) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", location);
        if (attr === "stroke-miterlimit" && (!numeric(attribute.value) || Number(attribute.value) < 1)) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", location);
        if (attr === "stroke-linecap" && !["butt", "round", "square"].includes(attribute.value)) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", location);
        if (attr === "stroke-linejoin" && !["miter", "round", "bevel"].includes(attribute.value)) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", location);
        if ((attr === "fill-rule" || attr === "clip-rule") && !["nonzero", "evenodd"].includes(attribute.value)) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", location);
        if (attr === "transform") inspectTransform(attribute.value, unsupported, features, location);
        continue;
      }
      addFinding(unsupported, "ANALYZE_UNSUPPORTED_ATTRIBUTE", location);
    }
    if (PRIMITIVES.has(name)) validateGeometry(element, unsupported, normalizations);
    if (name === "path") { const data = element.getAttribute("d") ?? ""; try { parsePathData(data, { operation: "analyze", domain: "svg" }, locationFor(name, "d")); } catch { addFinding(unsupported, "ANALYZE_INVALID_PATH_DATA", locationFor(name, "d")); } }
    if (name === "use") { const href = element.getAttribute("href") ?? element.getAttributeNS(XLINK_NS, "href") ?? ""; if (!href.startsWith("#") || !isLocalId(href.slice(1))) addFinding(unsupported, "ANALYZE_INVALID_REFERENCE", locationFor(name, "href")); else references.push({ target: href.slice(1), owner: currentOwner }); }
    if (name === "linearGradient") { const stops = children(element).filter((child) => child.localName === "stop"); if (stops.length < 2) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", locationFor(name)); }
    if (name === "stop") { const offset = element.getAttribute("offset") ?? ""; const parsed = offset.endsWith("%") ? Number(offset.slice(0, -1)) / 100 : Number(offset); if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", locationFor(name, "offset")); }
    const childElements = children(element);
    if (name === "g") { const names = new Set(childElements.map((child) => child.localName)); if (names.size !== 1 || (!names.has("path") && !names.has("use"))) addFeature(features, "group.mixed_or_nested_children"); if (childElements.length === 0) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", locationFor(name)); }
    for (const child of childElements) visit(child, name, insideDefs || name === "defs", currentOwner);
  };
  visit(root, "", false, null);
  if (artwork === 0) addFinding(unsupported, "ANALYZE_MISSING_ARTWORK", "/svg");
  for (const reference of references) if (!definitions.has(reference.target) || definitions.get(reference.target) === "linearGradient") addFinding(unsupported, "ANALYZE_INVALID_REFERENCE", "/svg/use/@href");
  for (const target of paintReferences) if (definitions.get(target) !== "linearGradient") addFinding(unsupported, "ANALYZE_INVALID_REFERENCE", "/svg/@fill");
  const graph = new Map<string, string[]>(); for (const reference of references) if (reference.owner !== null) graph.set(reference.owner, [...(graph.get(reference.owner) ?? []), reference.target]);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const cyclic = (node: string): boolean => { if (visiting.has(node)) return true; if (visited.has(node)) return false; visiting.add(node); for (const next of graph.get(node) ?? []) if (cyclic(next)) return true; visiting.delete(node); visited.add(node); return false; };
  for (const node of graph.keys()) if (cyclic(node)) { addFinding(unsupported, "ANALYZE_INVALID_REFERENCE", "/svg/use/@href"); break; }
  const version = root.getAttribute("version") ?? "";
  if (version === "1.0" || version === "1.1") normalizations.add("canonicalize_svg_version"); else if (version !== "") addFinding(unsupported, "ANALYZE_UNSUPPORTED_VERSION", "/svg/@version");
}

function validateGeometry(element: Element, unsupported: Map<AnalyzeCode, string>, normalizations: Set<AnalyzeNormalization>): void {
  const name = element.localName ?? "";
  const required: Record<string, readonly string[]> = { circle: ["r"], ellipse: ["rx", "ry"], rect: ["width", "height"], line: [], polyline: ["points"], polygon: ["points"] };
  for (const field of required[name] ?? []) if (!element.hasAttribute(field) || (field !== "points" && !numeric(element.getAttribute(field)))) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", locationFor(name, field));
  const defaults: Record<string, readonly string[]> = { circle: ["cx", "cy"], ellipse: ["cx", "cy"], rect: ["x", "y"], line: ["x1", "y1", "x2", "y2"] };
  for (const field of defaults[name] ?? []) { if (!element.hasAttribute(field)) normalizations.add("geometry_defaults_expanded"); else if (!numeric(element.getAttribute(field))) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", locationFor(name, field)); }
  if (name === "circle" && numeric(element.getAttribute("r")) && Number(element.getAttribute("r")) <= 0) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", locationFor(name, "r"));
  if (name === "ellipse") for (const field of ["rx", "ry"]) if (numeric(element.getAttribute(field)) && Number(element.getAttribute(field)) <= 0) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", locationFor(name, field));
  if (name === "rect") { for (const field of ["width", "height"]) if (numeric(element.getAttribute(field)) && Number(element.getAttribute(field)) <= 0) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", locationFor(name, field)); for (const field of ["rx", "ry"]) if (element.hasAttribute(field) && (!numeric(element.getAttribute(field)) || Number(element.getAttribute(field)) < 0)) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", locationFor(name, field)); if (element.hasAttribute("rx") !== element.hasAttribute("ry")) normalizations.add("rect_corner_completion"); }
  if (name === "polyline" || name === "polygon") { const values = (element.getAttribute("points") ?? "").trim().split(/[\s,]+/).filter(Boolean); if (values.length < (name === "polygon" ? 6 : 4) || values.length % 2 !== 0 || values.some((value) => !numeric(value))) addFinding(unsupported, "ANALYZE_INVALID_GEOMETRY", locationFor(name, "points")); }
}

function mapSchema1Diagnostic(diag: { readonly code: string; readonly location?: string; readonly message?: string }): AnalyzeCode {
  const code = diag.code;
  const loc = diag.location ?? "";
  const msg = diag.message ?? "";

  switch (code) {
    case "XML_LIMIT_EXCEEDED":
      return "ANALYZE_FILE_BYTE_LIMIT_EXCEEDED";
    case "XML_UNSAFE_DECLARATION":
      return "ANALYZE_UNSAFE_XML_DECLARATION";
    case "XML_UNSUPPORTED_PROCESSING_INSTRUCTION":
    case "XML_UNSUPPORTED_CDATA":
    case "XML_UNSUPPORTED_TEXT":
    case "XML_UNSUPPORTED_NODE":
    case "XML_UNSUPPORTED_MARKUP":
      return "ANALYZE_UNSUPPORTED_XML_NODE";
    case "XML_UNSUPPORTED_NAMESPACE":
      return "ANALYZE_UNSUPPORTED_NAMESPACE";
    case "XML_ACTIVE_CONTENT":
      return "ANALYZE_UNSAFE_ACTIVE_ATTRIBUTE";
    case "XML_UNSUPPORTED_ATTRIBUTE":
      return "ANALYZE_UNSUPPORTED_ATTRIBUTE";
    case "XML_EXTERNAL_REFERENCE":
      return "ANALYZE_UNSAFE_EXTERNAL_REFERENCE";
    case "XML_UNSUPPORTED_ELEMENT":
      return "ANALYZE_UNSUPPORTED_ELEMENT";
    case "XML_UNSUPPORTED_VERSION":
      return "ANALYZE_UNSUPPORTED_VERSION";
    case "XML_INVALID_ROOT":
      return "ANALYZE_INVALID_ROOT";
    case "XML_INVALID_VIEW_BOX":
      return "ANALYZE_INVALID_VIEWBOX";
    case "XML_INVALID_ACCESSIBILITY":
      return "ANALYZE_INVALID_ACCESSIBILITY";
    case "XML_SYNTAX":
      return "ANALYZE_SYNTAX_ERROR";
    case "XML_INVALID_ID":
    case "REFERENCE_DUPLICATE_ID":
      return "ANALYZE_INVALID_ID";
    case "XML_INVALID_PATH_DATA":
      return "ANALYZE_INVALID_PATH_DATA";
    case "XML_INVALID_PAINT":
    case "XML_INVALID_PAINT_FALLBACK":
    case "XML_INVALID_COLOR":
      return "ANALYZE_UNSUPPORTED_PAINT";
    case "XML_INVALID_TRANSFORM":
      return "ANALYZE_UNSUPPORTED_TRANSFORM";
    case "REFERENCE_UNRESOLVED":
      return "ANALYZE_INVALID_REFERENCE";
    case "XML_MISSING_ATTRIBUTE":
      if (loc.endsWith("@d")) return "ANALYZE_INVALID_PATH_DATA";
      if (loc.endsWith("@id")) return "ANALYZE_INVALID_ID";
      if (loc.endsWith("@viewBox")) return "ANALYZE_INVALID_VIEWBOX";
      if (loc.endsWith("@stop-color")) return "ANALYZE_UNSUPPORTED_PAINT";
      if (loc.endsWith("@role") || loc.endsWith("@aria-labelledby")) return "ANALYZE_INVALID_ACCESSIBILITY";
      return "ANALYZE_INVALID_GEOMETRY";
    case "XML_INVALID_RANGE":
      if (loc.endsWith("@viewBox")) return "ANALYZE_INVALID_VIEWBOX";
      if (loc.endsWith("@width") || loc.endsWith("@height")) return "ANALYZE_INVALID_CANVAS_DIMENSION";
      return "ANALYZE_INVALID_GEOMETRY";
    case "XML_INVALID_ENUM":
      if (loc.endsWith("@shape-rendering")) return "ANALYZE_INVALID_SHAPE_RENDERING";
      if (loc.endsWith("@aria-hidden") || loc.endsWith("@focusable") || loc.endsWith("@role")) return "ANALYZE_INVALID_ACCESSIBILITY";
      return "ANALYZE_INVALID_GEOMETRY";
    case "XML_INVALID_STRUCTURE":
      if (msg.toLowerCase().includes("artwork")) return "ANALYZE_MISSING_ARTWORK";
      return "ANALYZE_INVALID_ACCESSIBILITY";
    case "XML_INVALID_NUMBER":
      if (loc.endsWith("@width") || loc.endsWith("@height")) return "ANALYZE_INVALID_CANVAS_DIMENSION";
      if (loc.endsWith("@viewBox")) return "ANALYZE_INVALID_VIEWBOX";
      return "ANALYZE_INVALID_GEOMETRY";
    default:
      if (code.includes("ID")) return "ANALYZE_INVALID_ID";
      if (code.includes("PATH")) return "ANALYZE_INVALID_PATH_DATA";
      if (code.includes("REFERENCE")) return "ANALYZE_INVALID_REFERENCE";
      if (code.includes("UTF8")) return "ANALYZE_INVALID_UTF8";
      if (code.includes("SYNTAX") || code.includes("PARSE")) return "ANALYZE_SYNTAX_ERROR";
      return "ANALYZE_INVALID_GEOMETRY";
  }
}

export function scanAnalyzeSvg(bytes: Uint8Array, relativePath: string, derivedAssetId: string | null): { readonly file: AnalyzeDetailsFile; readonly xmlElements: number } {
  const inventory = inventoryTokens(bytes);
  if (inventory.canModel && inventory.text !== null) {
    const errors: string[] = [];
    try {
      const document = new DOMParser({ onError: (level) => { if (level !== "warning") errors.push(level); } }).parseFromString(inventory.text, "application/xml");
      if (errors.length > 0 || document.documentElement === null) addFinding(inventory.unsupported, "ANALYZE_SYNTAX_ERROR", "/svg");
      else inspectDom(document.documentElement, inventory);
    } catch { addFinding(inventory.unsupported, "ANALYZE_SYNTAX_ERROR", "/svg"); }
  }
  const commonDiagnostics = new Map(inventory.unsupported);
  const schemaDiagnostics = new Map<AnalyzeCode, string>();
  let schema1Direct = false;
  if (inventory.text !== null && bytes.byteLength <= ANALYZE_LIMITS.fileBytes) {
    const parsed = parseSvg(inventory.text, relativePath);
    schema1Direct = parsed.ok;
    if (!parsed.ok) {
      for (const item of parsed.diagnostics) {
        addFinding(schemaDiagnostics, mapSchema1Diagnostic(item), item.location?.startsWith("/svg") === true ? item.location : "/svg");
      }
    }
  } else {
    if (!inventory.validUtf8 || inventory.text === null) {
      addFinding(schemaDiagnostics, "ANALYZE_INVALID_UTF8", "/svg");
    }
    if (bytes.byteLength > ANALYZE_LIMITS.fileBytes) {
      addFinding(schemaDiagnostics, "ANALYZE_FILE_BYTE_LIMIT_EXCEEDED", "/svg");
    }
  }
  const unsafeDiagnostics = [...inventory.unsafe.entries()];
  const commonClassification: CommonV03Classification = unsafeDiagnostics.length > 0 ? "unsafe" : commonDiagnostics.size > 0 ? "unsupported" : inventory.normalizations.size > 0 || inventory.requiresCanonicalWhitespaceNormalization ? "importable_with_normalization" : "directly_importable";
  const schemaClassification: Schema1Classification = unsafeDiagnostics.length > 0 ? "unsafe" : schema1Direct ? "directly_importable" : "unsupported";
  const commonCodes = [...new Set([...unsafeDiagnostics.map(([code]) => code), ...commonDiagnostics.keys()])].sort(compareUtf8);
  const schemaCodes = [...new Set([...unsafeDiagnostics.map(([code]) => code), ...schemaDiagnostics.keys()])].sort(compareUtf8);
  const locations = [
    ...[...inventory.unsafe.entries(), ...schemaDiagnostics.entries()].map(([code, modelLocation]) => ({ profile: "schema1" as const, code, modelLocation })),
    ...[...inventory.unsafe.entries(), ...commonDiagnostics.entries()].map(([code, modelLocation]) => ({ profile: "commonV03" as const, code, modelLocation })),
  ].filter((item, index, values) => values.findIndex((other) => other.profile === item.profile && other.code === item.code && other.modelLocation === item.modelLocation) === index)
    .sort((left, right) => compareUtf8(left.profile, right.profile) || compareUtf8(left.code, right.code) || compareUtf8(left.modelLocation, right.modelLocation));
  const featureCodes = [...inventory.features].sort(compareUtf8);
  return {
    file: {
      recordType: "file", path: relativePath, derivedAssetId,
      profiles: {
        schema1: { profile: ANALYZE_SCHEMA1_PROFILE, classification: schemaClassification, diagnosticCodes: schemaCodes, featureCodes },
        commonV03: { profile: ANALYZE_COMMON_V03_PROFILE, classification: commonClassification, diagnosticCodes: commonCodes, featureCodes, normalizations: commonClassification === "importable_with_normalization" ? [...inventory.normalizations].sort(compareUtf8) : [] },
      },
      locations,
    },
    xmlElements: inventory.xmlElements,
  };
}
