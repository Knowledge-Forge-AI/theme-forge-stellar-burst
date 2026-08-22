import {
  DOMParser,
  MIME_TYPE,
  ParseError,
  onWarningStopParsing,
  type Document,
  type Element,
  type Node,
} from "@xmldom/xmldom";

import {
  DiagnosticError,
  fail,
  fromCaught,
  ok,
  type DiagnosticContext,
} from "./diagnostics.js";
import {
  formatNumber,
  normalizeText,
  parseHexColor,
  parseLocalId,
  parseNumberText,
  parsePathData,
  parseSvgPaint,
  parseTransform,
  serializePaint,
  serializeTransform,
} from "./primitives.js";
import type {
  ArtworkElement,
  DefinitionPath,
  DefinitionGroup,
  Definitions,
  GradientStop,
  LinearGradient,
  Paint,
  PathSpec,
  Presentation,
  Result,
  ShapeRendering,
  SvgDocument,
  UseSpec,
} from "./types.js";
import { validateSvgDocument } from "./validation.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const MAX_SVG_SOURCE_LENGTH = 8 * 1024 * 1024;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;
const DOCUMENT_TYPE_NODE = 10;

const PRESENTATION_ATTRIBUTES = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "aria-hidden",
] as const;

function context(source: string | undefined, operation: "parse" | "serialize" = "parse"): DiagnosticContext {
  return { operation, domain: "svg", ...(source === undefined ? {} : { source }) };
}

function preflightXml(text: string, ctx: DiagnosticContext): void {
  if (text.length > MAX_SVG_SOURCE_LENGTH) {
    fail(ctx, "XML_LIMIT_EXCEEDED", "SVG input exceeds the 8 MiB schema-1 limit.");
  }
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
      const declarationPattern = /^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])UTF-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>$/i;
      if (
        declarationSeen ||
        prefix.trim() !== "" ||
        !declarationPattern.test(instruction)
      ) {
        fail(
          ctx,
          "XML_UNSUPPORTED_PROCESSING_INSTRUCTION",
          "Only one leading XML 1.0 UTF-8 declaration is supported.",
        );
      }
      declarationSeen = true;
      position = end + 2;
      continue;
    }
    if (text.startsWith("<!", start)) {
      fail(
        ctx,
        "XML_UNSAFE_DECLARATION",
        "DOCTYPE, entity, CDATA, and other XML declarations are unsupported.",
      );
    }
    position = start + 1;
  }
}

function elementPath(parentPath: string, element: Element, index?: number): string {
  return `${parentPath}/${element.tagName}${index === undefined ? "" : `[${index}]`}`;
}

function assertSvgElement(element: Element, ctx: DiagnosticContext, path: string): void {
  if (
    element.namespaceURI !== SVG_NAMESPACE ||
    (element.prefix !== null && element.prefix !== "")
  ) {
    fail(ctx, "XML_UNSUPPORTED_NAMESPACE", "Only unprefixed SVG namespace elements are supported.", path);
  }
}

function childElements(parent: Node, ctx: DiagnosticContext, path: string): readonly Element[] {
  const elements: Element[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const node = parent.childNodes.item(index);
    if (node === null) continue;
    if (node.nodeType === COMMENT_NODE) continue;
    if (node.nodeType === TEXT_NODE) {
      if ((node.nodeValue ?? "").trim() !== "") {
        fail(ctx, "XML_UNSUPPORTED_TEXT", "Unexpected text outside a text-only SVG element.", path);
      }
      continue;
    }
    if (node.nodeType === ELEMENT_NODE) {
      const element = node as Element;
      assertSvgElement(element, ctx, elementPath(path, element, elements.length));
      elements.push(element);
      continue;
    }
    const code =
      node.nodeType === PROCESSING_INSTRUCTION_NODE
        ? "XML_UNSUPPORTED_PROCESSING_INSTRUCTION"
        : node.nodeType === DOCUMENT_TYPE_NODE
          ? "XML_UNSAFE_DECLARATION"
          : node.nodeType === CDATA_NODE
            ? "XML_UNSUPPORTED_CDATA"
            : "XML_UNSUPPORTED_NODE";
    fail(ctx, code, "Unsupported XML node in schema-1 SVG.", path);
  }
  return elements;
}

function textOnly(element: Element, ctx: DiagnosticContext, path: string): string {
  let text = "";
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const node = element.childNodes.item(index);
    if (node === null || node.nodeType === COMMENT_NODE) continue;
    if (node.nodeType !== TEXT_NODE) {
      fail(ctx, "XML_UNSUPPORTED_MARKUP", "This SVG element accepts text only.", path);
    }
    text += node.nodeValue ?? "";
  }
  return normalizeText(text);
}

function attributes(
  element: Element,
  allowed: readonly string[],
  ctx: DiagnosticContext,
  path: string,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const allowedSet = new Set(allowed);
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute === null) continue;
    if (attribute.namespaceURI === XMLNS_NAMESPACE || attribute.name === "xmlns") {
      if (attribute.name !== "xmlns" || attribute.value !== SVG_NAMESPACE) {
        fail(ctx, "XML_UNSUPPORTED_NAMESPACE", "Only the default SVG namespace declaration is supported.", `${path}/@${attribute.name}`);
      }
      result.set("xmlns", attribute.value);
      continue;
    }
    if (attribute.namespaceURI !== null && attribute.namespaceURI !== "") {
      fail(ctx, "XML_UNSUPPORTED_NAMESPACE", "Namespaced SVG attributes are unsupported.", `${path}/@${attribute.name}`);
    }
    if (!allowedSet.has(attribute.name)) {
      const code =
        /^on/i.test(attribute.name) || attribute.name === "style"
          ? "XML_ACTIVE_CONTENT"
          : "XML_UNSUPPORTED_ATTRIBUTE";
      fail(ctx, code, `Unsupported SVG attribute '${attribute.name}'.`, `${path}/@${attribute.name}`);
    }
    result.set(attribute.name, attribute.value);
  }
  return result;
}

function requiredAttribute(
  values: ReadonlyMap<string, string>,
  name: string,
  ctx: DiagnosticContext,
  path: string,
): string {
  const value = values.get(name);
  if (value === undefined || value === "") {
    fail(ctx, "XML_MISSING_ATTRIBUTE", `Missing required SVG attribute '${name}'.`, `${path}/@${name}`);
  }
  return value;
}

function parsePresentation(
  values: ReadonlyMap<string, string>,
  ctx: DiagnosticContext,
  path: string,
): Presentation {
  const fill = values.get("fill");
  const stroke = values.get("stroke");
  const strokeWidth = values.get("stroke-width");
  const miterlimit = values.get("stroke-miterlimit");
  const parsedStrokeWidth =
    strokeWidth === undefined
      ? undefined
      : parseNumberText(strokeWidth, ctx, `${path}/@stroke-width`);
  if (parsedStrokeWidth !== undefined && parsedStrokeWidth < 0) {
    fail(ctx, "XML_INVALID_RANGE", "stroke-width must be non-negative.", `${path}/@stroke-width`);
  }
  const parsedMiterlimit =
    miterlimit === undefined
      ? undefined
      : parseNumberText(miterlimit, ctx, `${path}/@stroke-miterlimit`);
  if (parsedMiterlimit !== undefined && parsedMiterlimit < 1) {
    fail(ctx, "XML_INVALID_RANGE", "stroke-miterlimit must be at least 1.", `${path}/@stroke-miterlimit`);
  }
  const linecap = values.get("stroke-linecap");
  if (linecap !== undefined && !["butt", "round", "square"].includes(linecap)) {
    fail(ctx, "XML_INVALID_ENUM", "Unsupported stroke-linecap value.", `${path}/@stroke-linecap`);
  }
  const linejoin = values.get("stroke-linejoin");
  if (linejoin !== undefined && !["miter", "round", "bevel"].includes(linejoin)) {
    fail(ctx, "XML_INVALID_ENUM", "Unsupported stroke-linejoin value.", `${path}/@stroke-linejoin`);
  }
  const rawOpacity = values.get("opacity");
  const opacity =
    rawOpacity === undefined
      ? undefined
      : parseNumberText(rawOpacity, ctx, `${path}/@opacity`);
  if (opacity !== undefined && (opacity < 0 || opacity > 1)) {
    fail(ctx, "XML_INVALID_RANGE", "opacity must be in [0, 1].", `${path}/@opacity`);
  }
  const rawAriaHidden = values.get("aria-hidden");
  let ariaHidden: boolean | undefined;
  if (rawAriaHidden !== undefined) {
    if (rawAriaHidden === "true") ariaHidden = true;
    else if (rawAriaHidden === "false") ariaHidden = false;
    else fail(ctx, "XML_INVALID_ENUM", "aria-hidden must be true or false.", `${path}/@aria-hidden`);
  }
  return {
    ...(fill === undefined ? {} : { fill: parseSvgPaint(fill, ctx, `${path}/@fill`) }),
    ...(stroke === undefined ? {} : { stroke: parseSvgPaint(stroke, ctx, `${path}/@stroke`) }),
    ...(parsedStrokeWidth === undefined ? {} : { strokeWidth: parsedStrokeWidth }),
    ...(linecap === undefined ? {} : { strokeLinecap: linecap as "butt" | "round" | "square" }),
    ...(linejoin === undefined ? {} : { strokeLinejoin: linejoin as "miter" | "round" | "bevel" }),
    ...(parsedMiterlimit === undefined ? {} : { strokeMiterlimit: parsedMiterlimit }),
    ...(opacity === undefined ? {} : { opacity }),
    ...(ariaHidden === undefined ? {} : { ariaHidden }),
  };
}

function parsePath(element: Element, ctx: DiagnosticContext, path: string): PathSpec {
  const values = attributes(
    element,
    ["id", "d", "transform", ...PRESENTATION_ATTRIBUTES],
    ctx,
    path,
  );
  const transform = parseTransform(values.get("transform"), ctx, `${path}/@transform`);
  return {
    ...parsePresentation(values, ctx, path),
    ...(values.get("id") === undefined
      ? {}
      : { id: parseLocalId(values.get("id"), ctx, `${path}/@id`) }),
    d: parsePathData(requiredAttribute(values, "d", ctx, path), ctx, `${path}/@d`),
    ...(transform === undefined ? {} : { transform }),
  };
}

function parseUse(element: Element, ctx: DiagnosticContext, path: string): UseSpec {
  const values = attributes(
    element,
    ["id", "href", "x", "y", "transform", ...PRESENTATION_ATTRIBUTES],
    ctx,
    path,
  );
  const href = requiredAttribute(values, "href", ctx, path);
  if (!href.startsWith("#") || href.length === 1) {
    fail(ctx, "XML_EXTERNAL_REFERENCE", "href must be an asset-local #id reference.", `${path}/@href`);
  }
  const rawX = values.get("x");
  const rawY = values.get("y");
  const x = rawX === undefined ? undefined : parseNumberText(rawX, ctx, `${path}/@x`);
  const y = rawY === undefined ? undefined : parseNumberText(rawY, ctx, `${path}/@y`);
  const transform = parseTransform(values.get("transform"), ctx, `${path}/@transform`);
  return {
    ...parsePresentation(values, ctx, path),
    ...(values.get("id") === undefined
      ? {}
      : { id: parseLocalId(values.get("id"), ctx, `${path}/@id`) }),
    href: parseLocalId(href.slice(1), ctx, `${path}/@href`),
    ...(x === undefined || x === 0 ? {} : { x }),
    ...(y === undefined || y === 0 ? {} : { y }),
    ...(transform === undefined ? {} : { transform }),
  };
}

function parseGradientStop(element: Element, ctx: DiagnosticContext, path: string): GradientStop {
  const values = attributes(element, ["offset", "stop-color", "stop-opacity"], ctx, path);
  const offsetText = requiredAttribute(values, "offset", ctx, path);
  const offset = offsetText.endsWith("%")
    ? parseNumberText(offsetText.slice(0, -1), ctx, `${path}/@offset`) / 100
    : parseNumberText(offsetText, ctx, `${path}/@offset`);
  if (offset < 0 || offset > 1) {
    fail(ctx, "XML_INVALID_RANGE", "Gradient offset must normalize to [0, 1].", `${path}/@offset`);
  }
  const opacityText = values.get("stop-opacity");
  const opacity =
    opacityText === undefined
      ? undefined
      : parseNumberText(opacityText, ctx, `${path}/@stop-opacity`);
  if (opacity !== undefined && (opacity < 0 || opacity > 1)) {
    fail(ctx, "XML_INVALID_RANGE", "stop-opacity must be in [0, 1].", `${path}/@stop-opacity`);
  }
  return {
    offset,
    color: parseHexColor(
      requiredAttribute(values, "stop-color", ctx, path),
      ctx,
      `${path}/@stop-color`,
    ),
    ...(opacity === undefined || opacity === 1 ? {} : { opacity }),
  };
}

function parseLinearGradient(element: Element, ctx: DiagnosticContext, path: string): LinearGradient {
  const values = attributes(
    element,
    ["id", "x1", "y1", "x2", "y2", "gradientUnits"],
    ctx,
    path,
  );
  const units = values.get("gradientUnits");
  if (units !== undefined && units !== "userSpaceOnUse" && units !== "objectBoundingBox") {
    fail(ctx, "XML_INVALID_ENUM", "Unsupported gradientUnits value.", `${path}/@gradientUnits`);
  }
  const children = childElements(element, ctx, path);
  if (children.length < 2 || children.some((child) => child.localName !== "stop")) {
    fail(ctx, "XML_UNSUPPORTED_ELEMENT", "A linearGradient requires at least two stop children.", path);
  }
  return {
    id: parseLocalId(requiredAttribute(values, "id", ctx, path), ctx, `${path}/@id`),
    x1: parseNumberText(requiredAttribute(values, "x1", ctx, path), ctx, `${path}/@x1`),
    y1: parseNumberText(requiredAttribute(values, "y1", ctx, path), ctx, `${path}/@y1`),
    x2: parseNumberText(requiredAttribute(values, "x2", ctx, path), ctx, `${path}/@x2`),
    y2: parseNumberText(requiredAttribute(values, "y2", ctx, path), ctx, `${path}/@y2`),
    ...(units === "userSpaceOnUse" ? { units } : {}),
    stops: children.map((child, index) =>
      parseGradientStop(child, ctx, `${path}/stop[${index}]`),
    ),
  };
}

function parseDefinitionGroup(element: Element, ctx: DiagnosticContext, path: string): DefinitionGroup {
  const values = attributes(element, ["id", ...PRESENTATION_ATTRIBUTES], ctx, path);
  const children = childElements(element, ctx, path);
  if (children.length === 0 || children.some((child) => child.localName !== "path")) {
    fail(ctx, "XML_UNSUPPORTED_ELEMENT", "Definition groups may contain supported paths only.", path);
  }
  return {
    ...parsePresentation(values, ctx, path),
    id: parseLocalId(requiredAttribute(values, "id", ctx, path), ctx, `${path}/@id`),
    paths: children.map((child, index) => parsePath(child, ctx, `${path}/path[${index}]`)),
  };
}

function parseDefinitions(element: Element, ctx: DiagnosticContext, path: string): Definitions {
  attributes(element, [], ctx, path);
  const linearGradients: LinearGradient[] = [];
  const groups: DefinitionGroup[] = [];
  const paths: DefinitionPath[] = [];
  for (const child of childElements(element, ctx, path)) {
    const childPath = `${path}/${child.localName}`;
    if (child.localName === "linearGradient") {
      linearGradients.push(parseLinearGradient(child, ctx, childPath));
    } else if (child.localName === "g") {
      groups.push(parseDefinitionGroup(child, ctx, childPath));
    } else if (child.localName === "path") {
      const parsed = parsePath(child, ctx, childPath);
      if (parsed.id === undefined) {
        fail(ctx, "XML_MISSING_ATTRIBUTE", "Definition paths require an id.", `${childPath}/@id`);
      }
      paths.push({ ...parsed, id: parsed.id });
    } else {
      fail(ctx, "XML_UNSUPPORTED_ELEMENT", `Unsupported defs element '${child.tagName}'.`, childPath);
    }
  }
  return { linearGradients, groups, paths };
}

function parseArtworkGroup(element: Element, ctx: DiagnosticContext, path: string): ArtworkElement {
  const values = attributes(
    element,
    ["id", "transform", ...PRESENTATION_ATTRIBUTES],
    ctx,
    path,
  );
  const children = childElements(element, ctx, path);
  if (children.length === 0) {
    fail(ctx, "XML_UNSUPPORTED_ELEMENT", "Artwork groups cannot be empty.", path);
  }
  const names = new Set(children.map((child) => child.localName));
  if (names.size !== 1 || (!names.has("path") && !names.has("use"))) {
    fail(ctx, "XML_UNSUPPORTED_ELEMENT", "Artwork groups must contain only paths or only uses.", path);
  }
  const transform = parseTransform(values.get("transform"), ctx, `${path}/@transform`);
  return {
    type: "group",
    ...parsePresentation(values, ctx, path),
    ...(values.get("id") === undefined
      ? {}
      : { id: parseLocalId(values.get("id"), ctx, `${path}/@id`) }),
    ...(transform === undefined ? {} : { transform }),
    body: names.has("path")
      ? {
          type: "paths",
          paths: children.map((child, index) => parsePath(child, ctx, `${path}/path[${index}]`)),
        }
      : {
          type: "uses",
          uses: children.map((child, index) => parseUse(child, ctx, `${path}/use[${index}]`)),
        },
  };
}

function parseArtworkElement(element: Element, ctx: DiagnosticContext, index: number): ArtworkElement {
  const localName = element.localName ?? element.tagName;
  const path = `/svg/${localName}[${index}]`;
  if (localName === "path") return { type: "path", ...parsePath(element, ctx, path) };
  if (localName === "use") return { type: "use", ...parseUse(element, ctx, path) };
  if (localName === "g") return parseArtworkGroup(element, ctx, path);
  const active = ["script", "image", "foreignObject", "style", "animate", "animateTransform"];
  fail(
    ctx,
    active.includes(localName) ? "XML_ACTIVE_CONTENT" : "XML_UNSUPPORTED_ELEMENT",
    `Unsupported SVG artwork element '${element.tagName}'.`,
    path,
  );
}

function parseViewBox(value: string, ctx: DiagnosticContext): readonly [number, number, number, number] {
  const parts = value.trim().split(/[\t\n\r ]+/);
  if (parts.length !== 4) {
    fail(ctx, "XML_INVALID_VIEW_BOX", "viewBox must contain four finite numbers.", "/svg/@viewBox");
  }
  const numbers = parts.map((part) => parseNumberText(part, ctx, "/svg/@viewBox"));
  const [x = 0, y = 0, width = 0, height = 0] = numbers;
  if (width <= 0 || height <= 0) {
    fail(ctx, "XML_INVALID_RANGE", "viewBox width and height must be positive.", "/svg/@viewBox");
  }
  return [x, y, width, height];
}

function decodeDocument(document: Document, ctx: DiagnosticContext): SvgDocument {
  const root = document.documentElement;
  if (root === null || root.localName !== "svg") {
    fail(ctx, "XML_INVALID_ROOT", "Document root must be an SVG element.", "/");
  }
  assertSvgElement(root, ctx, "/svg");
  for (let index = 0; index < document.childNodes.length; index += 1) {
    const node = document.childNodes.item(index);
    if (
      node !== null &&
      node !== root &&
      node.nodeType !== COMMENT_NODE &&
      !(node.nodeType === PROCESSING_INSTRUCTION_NODE && node.nodeName.toLowerCase() === "xml") &&
      !(node.nodeType === TEXT_NODE && (node.nodeValue ?? "").trim() === "")
    ) {
      fail(ctx, "XML_UNSUPPORTED_NODE", "Unsupported XML node outside the SVG root.", "/");
    }
  }

  const rootAttributes = attributes(
    root,
    ["xmlns", "version", "width", "height", "viewBox", "role", "aria-labelledby", "focusable", "shape-rendering"],
    ctx,
    "/svg",
  );
  if (rootAttributes.get("xmlns") !== SVG_NAMESPACE) {
    fail(ctx, "XML_UNSUPPORTED_NAMESPACE", "The SVG root must declare the canonical SVG namespace.", "/svg/@xmlns");
  }
  const rawVersion = rootAttributes.get("version");
  if (rawVersion !== undefined && rawVersion !== "1.1") {
    fail(ctx, "XML_UNSUPPORTED_VERSION", "Only SVG version 1.1 is supported.", "/svg/@version");
  }
  if (requiredAttribute(rootAttributes, "role", ctx, "/svg") !== "img") {
    fail(ctx, "XML_INVALID_ACCESSIBILITY", "SVG role must be img.", "/svg/@role");
  }
  const rawWidth = rootAttributes.get("width");
  const rawHeight = rootAttributes.get("height");
  const width =
    rawWidth === undefined
      ? undefined
      : parseNumberText(rawWidth, ctx, "/svg/@width");
  if (width !== undefined && width <= 0) {
    fail(ctx, "XML_INVALID_RANGE", "SVG width must be positive.", "/svg/@width");
  }
  const height =
    rawHeight === undefined
      ? undefined
      : parseNumberText(rawHeight, ctx, "/svg/@height");
  if (height !== undefined && height <= 0) {
    fail(ctx, "XML_INVALID_RANGE", "SVG height must be positive.", "/svg/@height");
  }
  const rawFocusable = rootAttributes.get("focusable");
  let focusable: boolean | undefined;
  if (rawFocusable !== undefined) {
    if (rawFocusable === "false") focusable = false;
    else if (rawFocusable === "true") focusable = true;
    else fail(ctx, "XML_INVALID_ENUM", "focusable must be true or false.", "/svg/@focusable");
  }
  const rawShapeRendering = rootAttributes.get("shape-rendering");
  if (
    rawShapeRendering !== undefined &&
    !["auto", "optimizeSpeed", "crispEdges", "geometricPrecision"].includes(rawShapeRendering)
  ) {
    fail(ctx, "XML_INVALID_ENUM", "Unsupported shape-rendering value.", "/svg/@shape-rendering");
  }

  const children = childElements(root, ctx, "/svg");
  if (children[0]?.localName !== "title" || children[1]?.localName !== "desc") {
    fail(ctx, "XML_INVALID_STRUCTURE", "SVG must begin with exactly one title followed by one desc.", "/svg");
  }
  const titleElement = children[0];
  const descriptionElement = children[1];
  if (titleElement === undefined || descriptionElement === undefined) {
    fail(ctx, "XML_INVALID_STRUCTURE", "SVG requires title and desc elements.", "/svg");
  }
  const titleAttributes = attributes(titleElement, ["id"], ctx, "/svg/title");
  const descriptionAttributes = attributes(descriptionElement, ["id"], ctx, "/svg/desc");
  const titleId = parseLocalId(requiredAttribute(titleAttributes, "id", ctx, "/svg/title"), ctx, "/svg/title/@id");
  const descriptionId = parseLocalId(
    requiredAttribute(descriptionAttributes, "id", ctx, "/svg/desc"),
    ctx,
    "/svg/desc/@id",
  );
  const title = textOnly(titleElement, ctx, "/svg/title");
  const description = textOnly(descriptionElement, ctx, "/svg/desc");
  if (title === "" || description === "") {
    fail(ctx, "XML_INVALID_ACCESSIBILITY", "Accessibility text cannot normalize to empty.", "/svg");
  }
  const labelledBy = requiredAttribute(rootAttributes, "aria-labelledby", ctx, "/svg");
  if (labelledBy !== `${titleId} ${descriptionId}`) {
    fail(ctx, "XML_INVALID_ACCESSIBILITY", "aria-labelledby must name title then desc exactly.", "/svg/@aria-labelledby");
  }

  let cursor = 2;
  let metadataText: string | undefined;
  if (children[cursor]?.localName === "metadata") {
    const metadata = children[cursor];
    if (metadata === undefined) throw new Error("unreachable");
    attributes(metadata, [], ctx, "/svg/metadata");
    metadataText = textOnly(metadata, ctx, "/svg/metadata");
    cursor += 1;
  }
  let definitions: Definitions = { linearGradients: [], groups: [], paths: [] };
  if (children[cursor]?.localName === "defs") {
    const defs = children[cursor];
    if (defs === undefined) throw new Error("unreachable");
    definitions = parseDefinitions(defs, ctx, "/svg/defs");
    cursor += 1;
  }
  const artwork = children.slice(cursor);
  if (artwork.length === 0) {
    fail(ctx, "XML_INVALID_STRUCTURE", "SVG requires at least one artwork element.", "/svg");
  }
  const svg: SvgDocument = {
    canvas: {
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      viewBox: parseViewBox(requiredAttribute(rootAttributes, "viewBox", ctx, "/svg"), ctx),
      ...(rawShapeRendering === undefined || rawShapeRendering === "auto"
        ? {}
        : { shapeRendering: rawShapeRendering as ShapeRendering }),
    },
    accessibility: {
      title,
      titleId,
      description,
      descriptionId,
      ...(focusable === undefined ? {} : { focusable }),
    },
    ...(metadataText === undefined ? {} : { metadataText }),
    definitions,
    elements: artwork.map((element, index) => parseArtworkElement(element, ctx, index)),
  };
  validateSvgDocument(svg, ctx);
  return svg;
}

export function parseSvg(text: string, source?: string): Result<SvgDocument> {
  const ctx = context(source);
  try {
    const normalizedText = text.replace(/^\uFEFF/, "");
    preflightXml(normalizedText, ctx);
    const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(
      normalizedText,
      MIME_TYPE.XML_APPLICATION,
    );
    return ok(decodeDocument(document, ctx));
  } catch (error) {
    return fromCaught(
      error,
      ctx,
      "XML_SYNTAX",
      "Invalid or malformed XML.",
      (caught) => caught instanceof ParseError,
    );
  }
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function attribute(name: string, value: string | number | undefined): string {
  if (value === undefined) return "";
  const serialized = typeof value === "number" ? formatNumber(value) : value;
  return ` ${name}="${escapeAttribute(serialized)}"`;
}

function textElement(tag: string, id: string | undefined, value: string, depth: number): readonly string[] {
  const indent = "  ".repeat(depth);
  const idAttribute = attribute("id", id);
  if (value === "") return [`${indent}<${tag}${idAttribute}/>`];
  if (!value.includes("\n")) {
    return [`${indent}<${tag}${idAttribute}>${escapeText(value)}</${tag}>`];
  }
  const lines = value.split("\n");
  return [
    `${indent}<${tag}${idAttribute}>`,
    ...lines.map((line) => `${"  ".repeat(depth + 1)}${escapeText(line)}`),
    `${indent}</${tag}>`,
  ];
}

function presentationAttributes(value: Presentation): string {
  return [
    value.fill === undefined ? "" : attribute("fill", serializePaint(value.fill)),
    value.stroke === undefined ? "" : attribute("stroke", serializePaint(value.stroke)),
    attribute("stroke-width", value.strokeWidth),
    attribute("stroke-linecap", value.strokeLinecap),
    attribute("stroke-linejoin", value.strokeLinejoin),
    attribute("stroke-miterlimit", value.strokeMiterlimit),
    attribute("opacity", value.opacity),
    attribute(
      "aria-hidden",
      value.ariaHidden === undefined ? undefined : (value.ariaHidden ? "true" : "false"),
    ),
  ].join("");
}

function renderPath(path: PathSpec, depth: number): string {
  return `${"  ".repeat(depth)}<path${attribute("id", path.id)}${presentationAttributes(path)}${attribute(
    "transform",
    serializeTransform(path.transform),
  )}${attribute("d", path.d)}/>`;
}

function renderUse(use: UseSpec, depth: number): string {
  return `${"  ".repeat(depth)}<use${attribute("id", use.id)}${attribute("href", `#${use.href}`)}${attribute(
    "x",
    use.x,
  )}${attribute("y", use.y)}${presentationAttributes(use)}${attribute(
    "transform",
    serializeTransform(use.transform),
  )}/>`;
}

function renderGradient(gradient: LinearGradient, depth: number): readonly string[] {
  const indent = "  ".repeat(depth);
  return [
    `${indent}<linearGradient${attribute("id", gradient.id)}${attribute("x1", gradient.x1)}${attribute(
      "y1",
      gradient.y1,
    )}${attribute("x2", gradient.x2)}${attribute("y2", gradient.y2)}${attribute(
      "gradientUnits",
      gradient.units,
    )}>`,
    ...gradient.stops.map(
      (stop) =>
        `${"  ".repeat(depth + 1)}<stop${attribute("offset", stop.offset)}${attribute(
          "stop-color",
          stop.color,
        )}${attribute("stop-opacity", stop.opacity)}/>` ,
    ),
    `${indent}</linearGradient>`,
  ];
}

function renderDefinitionGroup(group: DefinitionGroup, depth: number): readonly string[] {
  const indent = "  ".repeat(depth);
  return [
    `${indent}<g${attribute("id", group.id)}${presentationAttributes(group)}>`,
    ...group.paths.map((path) => renderPath(path, depth + 1)),
    `${indent}</g>`,
  ];
}

function renderArtwork(element: ArtworkElement, depth: number): readonly string[] {
  if (element.type === "path") return [renderPath(element, depth)];
  if (element.type === "use") return [renderUse(element, depth)];
  const indent = "  ".repeat(depth);
  const open = `${indent}<g${attribute("id", element.id)}${presentationAttributes(element)}${attribute(
    "transform",
    serializeTransform(element.transform),
  )}>`;
  const children =
    element.body.type === "paths"
      ? element.body.paths.map((path) => renderPath(path, depth + 1))
      : element.body.uses.map((use) => renderUse(use, depth + 1));
  return [open, ...children, `${indent}</g>`];
}

function renderSvg(svg: SvgDocument): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg${attribute("xmlns", SVG_NAMESPACE)}${attribute("width", svg.canvas.width)}${attribute(
      "height",
      svg.canvas.height,
    )}${attribute("viewBox", svg.canvas.viewBox.map(formatNumber).join(" "))}${attribute(
      "role",
      "img",
    )}${attribute(
      "aria-labelledby",
      `${svg.accessibility.titleId} ${svg.accessibility.descriptionId}`,
    )}${attribute(
      "focusable",
      svg.accessibility.focusable === undefined ? undefined : (svg.accessibility.focusable ? "true" : "false"),
    )}${attribute("shape-rendering", svg.canvas.shapeRendering)}>`,
    ...textElement("title", svg.accessibility.titleId, svg.accessibility.title, 1),
    ...textElement("desc", svg.accessibility.descriptionId, svg.accessibility.description, 1),
  ];
  if (svg.metadataText !== undefined) {
    lines.push(...textElement("metadata", undefined, svg.metadataText, 1));
  }
  const definitions = svg.definitions;
  if (
    definitions.linearGradients.length > 0 ||
    definitions.groups.length > 0 ||
    definitions.paths.length > 0
  ) {
    lines.push("  <defs>");
    for (const gradient of definitions.linearGradients) lines.push(...renderGradient(gradient, 2));
    for (const group of definitions.groups) lines.push(...renderDefinitionGroup(group, 2));
    for (const path of definitions.paths) lines.push(renderPath(path, 2));
    lines.push("  </defs>");
  }
  for (const element of svg.elements) lines.push(...renderArtwork(element, 1));
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

export function serializeSvg(svg: SvgDocument, source?: string): Result<string> {
  const ctx = context(source, "serialize");
  try {
    validateSvgDocument(svg, ctx);
    return ok(renderSvg(svg));
  } catch (error) {
    if (error instanceof DiagnosticError) {
      return { ok: false, diagnostics: [error.diagnostic] };
    }
    throw error;
  }
}
