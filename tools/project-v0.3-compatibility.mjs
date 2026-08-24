import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DOMParser } from "@xmldom/xmldom";

import { stableJson } from "./audit-dogfood-corpus.mjs";

const SAMPLE_LIMIT = 5;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** @typedef {{schema1Compatible:boolean, minimumStage:number, requiredFeatures:Set<string>, normalizations:Set<string>, unsupported:Set<string>, unsafe:Set<string>, references:Set<string>}} ProjectionRecord */
/** @typedef {{id:string, path:string, origin:string, revision:string}} CorpusInput */
/** @typedef {(text:string, source?:string) => {ok:boolean}} Schema1Parser */

export const PROJECTION_STAGES = [
  { id: "schema-1", label: "schema 1 current behavior" },
  { id: "accessibility", label: "accessibility ownership union" },
  { id: "document-presentation", label: "root presentation and currentColor" },
  { id: "basic-geometry", label: "common basic geometry" },
  { id: "transforms-references", label: "selected transforms and local references" },
  { id: "v0.3-profile", label: "complete proposed v0.3 profile" },
];

const STAGE_NUMBER = Object.fromEntries(PROJECTION_STAGES.map((stage, index) => [stage.id, index + 1]));
const BASIC_ELEMENTS = new Set(["svg", "title", "desc", "metadata", "defs", "linearGradient", "stop", "path", "g", "use"]);
const GEOMETRY_ELEMENTS = new Set(["circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const UNSAFE_ELEMENTS = new Set([
  "script", "style", "image", "foreignObject", "animate", "animateColor",
  "animateMotion", "animateTransform", "set", "iframe", "object", "embed", "audio", "video",
]);
const ROOT_BASE = new Set(["xmlns", "version", "width", "height", "viewBox", "role", "aria-labelledby", "aria-hidden", "focusable", "shape-rendering"]);
const PRESENTATION = new Set([
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule", "aria-hidden",
]);
const ATTRIBUTES = /** @type {Record<string, Set<string>>} */ ({
  title: new Set(["id"]),
  desc: new Set(["id"]),
  metadata: new Set([]),
  defs: new Set([]),
  linearGradient: new Set(["id", "x1", "y1", "x2", "y2", "gradientUnits"]),
  stop: new Set(["offset", "stop-color", "stop-opacity"]),
  path: new Set(["id", "d", "transform"]),
  g: new Set(["id", "transform"]),
  use: new Set(["id", "href", "x", "y", "transform"]),
  circle: new Set(["id", "cx", "cy", "r", "transform"]),
  ellipse: new Set(["id", "cx", "cy", "rx", "ry", "transform"]),
  rect: new Set(["id", "x", "y", "width", "height", "rx", "ry", "transform"]),
  line: new Set(["id", "x1", "y1", "x2", "y2", "transform"]),
  polyline: new Set(["id", "points", "transform"]),
  polygon: new Set(["id", "points", "transform"]),
});

/** @param {string} left @param {string} right */
function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** @param {string} path */
function deriveAssetId(path) {
  const stem = basename(path).slice(0, -4).normalize("NFC");
  const id = stem.toLowerCase().replace(/[ _]+/g, "-");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? id : null;
}

/** @param {Map<string, string[]>} groups */
function collisionSummary(groups) {
  const collisions = [...groups.values()].filter((paths) => paths.length > 1);
  return {
    groups: collisions.length,
    affectedFiles: collisions.reduce((total, paths) => total + paths.length, 0),
  };
}

/** @param {string} root @returns {Promise<string[]>} */
async function svgPaths(root) {
  /** @type {string[]} */
  const paths = [];
  /** @param {string} directory */
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".svg") {
        paths.push(relative(root, absolute).split("\\").join("/"));
      }
    }
  }
  await walk(root);
  return paths;
}

/** @param {Set<string>} target @param {string} code */
function issue(target, code) {
  target.add(code);
}

/** @param {ProjectionRecord} record @param {number} stage @param {string} code */
function addMinimum(record, stage, code) {
  record.minimumStage = Math.max(record.minimumStage, stage);
  issue(record.requiredFeatures, code);
}

/** @param {string | null} value */
function numeric(value) {
  return value !== null && value.trim() !== "" && Number.isFinite(Number(value));
}

/** @param {string} value */
function paintKind(value) {
  const trimmed = value.trim();
  if (trimmed === "none") return "supported";
  if (trimmed === "currentColor") return "currentColor";
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return "supported";
  if (/^url\(#[A-Za-z_][A-Za-z0-9_.:-]*\)$/.test(trimmed)) return "supported";
  if (/url\s*\(/i.test(trimmed)) return "external";
  return "unsupported";
}

/** @param {string} value @returns {string[] | null} */
function transformFunctions(value) {
  const names = [];
  const pattern = /([A-Za-z][A-Za-z0-9]*)\s*\(([^)]*)\)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    if (value.slice(cursor, match.index).trim() !== "") return null;
    const name = match[1];
    if (name === undefined) return null;
    names.push(name);
    cursor = pattern.lastIndex;
  }
  return cursor > 0 && value.slice(cursor).trim() === "" ? names : null;
}

/** @param {string} value */
function hasExternalReference(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return false;
  if (/^url\(#[^)]+\)$/.test(trimmed)) return false;
  return /(?:url\s*\(|^[a-z][a-z0-9+.-]*:|^\/\/|^\/)/i.test(trimmed);
}

/** @param {any} element */
function textContent(element) {
  let text = "";
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const node = element.childNodes.item(index);
    if (node?.nodeType === 3) text += node.nodeValue ?? "";
  }
  return text.replace(/[\t\n\r ]+/g, " ").trim();
}

/** @param {any} element @returns {any[]} */
function elementChildren(element) {
  const children = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const node = element.childNodes.item(index);
    if (node?.nodeType === 1) children.push(node);
  }
  return children;
}

/** @param {any} element @param {ProjectionRecord} record */
function validateGeometry(element, record) {
  const name = element.localName;
  const required = /** @type {Record<string, string[]>} */ ({
    circle: ["r"], ellipse: ["rx", "ry"],
    rect: ["width", "height"], line: [],
  })[name];
  if (required !== undefined) {
    for (const field of required) {
      if (!element.hasAttribute(field) || !numeric(element.getAttribute(field))) {
        issue(record.unsupported, "SVG_GEOMETRY_INVALID");
      }
    }
  }
  if (name === "circle" && numeric(element.getAttribute("r")) && Number(element.getAttribute("r")) <= 0) issue(record.unsupported, "SVG_GEOMETRY_INVALID");
  const defaultable = /** @type {Record<string, string[]>} */ ({
    circle: ["cx", "cy"], ellipse: ["cx", "cy"], rect: ["x", "y"], line: ["x1", "y1", "x2", "y2"],
  })[name] ?? [];
  for (const field of defaultable) {
    if (!element.hasAttribute(field)) issue(record.normalizations, "geometry_defaults_expanded");
    else if (!numeric(element.getAttribute(field))) issue(record.unsupported, "SVG_GEOMETRY_INVALID");
  }
  if (name === "ellipse") {
    for (const field of ["rx", "ry"]) if (numeric(element.getAttribute(field)) && Number(element.getAttribute(field)) <= 0) issue(record.unsupported, "SVG_GEOMETRY_INVALID");
  }
  if (name === "rect") {
    for (const field of ["width", "height"]) if (numeric(element.getAttribute(field)) && Number(element.getAttribute(field)) <= 0) issue(record.unsupported, "SVG_GEOMETRY_INVALID");
    for (const field of ["rx", "ry"]) if (element.hasAttribute(field) && (!numeric(element.getAttribute(field)) || Number(element.getAttribute(field)) < 0)) issue(record.unsupported, "SVG_GEOMETRY_INVALID");
    if (element.hasAttribute("rx") !== element.hasAttribute("ry")) issue(record.normalizations, "rect_corner_completion");
  }
  if (name === "polyline" || name === "polygon") {
    /** @type {string[]} */
    const numbers = String(element.getAttribute("points") ?? "").trim().split(/[\s,]+/).filter(Boolean);
    const minimum = name === "polygon" ? 6 : 4;
    if (numbers.length < minimum || numbers.length % 2 !== 0 || numbers.some((part) => !numeric(part))) issue(record.unsupported, "SVG_POINTS_INVALID");
  }
}

/** @param {any} element @param {ProjectionRecord} record @param {Map<string, string>} ids */
function inspectElement(element, record, ids) {
  const name = element.localName ?? element.tagName;
  if (UNSAFE_ELEMENTS.has(name)) issue(record.unsafe, "SVG_ACTIVE_ELEMENT");
  else if (GEOMETRY_ELEMENTS.has(name)) addMinimum(record, 4, `element.${name}`);
  else if (!BASIC_ELEMENTS.has(name)) issue(record.unsupported, "SVG_UNSUPPORTED_ELEMENT");

  if (element.namespaceURI !== SVG_NAMESPACE || (element.prefix !== null && element.prefix !== "")) {
    issue(record.unsupported, "SVG_UNSUPPORTED_NAMESPACE");
  }

  if (element.hasAttribute("id")) {
    const id = element.getAttribute("id");
    if (id === "" || ids.has(id)) issue(record.unsupported, "SVG_INVALID_OR_DUPLICATE_ID");
    ids.set(id, name);
  }

  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute === null) continue;
    const attributeName = attribute.name;
    const local = attribute.localName ?? attributeName;
    if (attribute.namespaceURI === XMLNS_NAMESPACE || attributeName === "xmlns") {
      if (attributeName === "xmlns" && attribute.value === SVG_NAMESPACE) continue;
      if (attributeName === "xmlns:xlink" && attribute.value === XLINK_NAMESPACE) {
        addMinimum(record, 5, "namespace.xlink");
        issue(record.normalizations, "xlink_namespace_to_svg2_href");
        continue;
      }
      issue(record.unsupported, "SVG_UNSUPPORTED_NAMESPACE");
      continue;
    }
    if (attribute.namespaceURI === XLINK_NAMESPACE && local === "href" && name === "use") {
      if (hasExternalReference(attribute.value)) issue(record.unsafe, "SVG_EXTERNAL_REFERENCE");
      else {
        addMinimum(record, 5, "reference.xlink_local");
        issue(record.normalizations, "xlink_href_to_href");
      }
      continue;
    }
    if (attribute.namespaceURI === XML_NAMESPACE || (attribute.namespaceURI !== null && attribute.namespaceURI !== "")) {
      issue(record.unsupported, "SVG_UNSUPPORTED_NAMESPACE");
      continue;
    }
    if (/^on/i.test(attributeName) || attributeName === "style") {
      issue(record.unsafe, "SVG_ACTIVE_ATTRIBUTE");
      continue;
    }
    if (["href", "src"].includes(local) && hasExternalReference(attribute.value)) {
      issue(record.unsafe, "SVG_EXTERNAL_REFERENCE");
      continue;
    }
    if (attributeName === "class") {
      issue(record.unsupported, "SVG_UNSUPPORTED_CSS_CLASS");
      continue;
    }
    if (name === "svg" && ROOT_BASE.has(attributeName)) continue;
    const allowed = ATTRIBUTES[name];
    if (allowed?.has(attributeName)) {
      if (name === "use" && local === "href") {
        if (hasExternalReference(attribute.value)) issue(record.unsafe, "SVG_EXTERNAL_REFERENCE");
      }
      continue;
    }
    if (PRESENTATION.has(attributeName) && name !== "title" && name !== "desc" && name !== "metadata" && name !== "defs") {
      if (name === "svg") {
        addMinimum(record, 3, `root-presentation.${attributeName}`);
        issue(record.normalizations, "promote_root_presentation");
      }
      if (["fill-rule", "clip-rule", "fill-opacity", "stroke-opacity"].includes(attributeName)) addMinimum(record, 3, `presentation.${attributeName}`);
      if (attributeName === "fill" || attributeName === "stroke") {
        const kind = paintKind(attribute.value);
        if (kind === "currentColor") addMinimum(record, 3, "paint.currentColor");
        else if (kind === "external") issue(record.unsafe, "SVG_EXTERNAL_REFERENCE");
        else if (kind === "unsupported") issue(record.unsupported, "SVG_UNSUPPORTED_PAINT");
      }
      continue;
    }
    issue(record.unsupported, "SVG_UNSUPPORTED_ATTRIBUTE");
  }

  const transform = element.getAttribute("transform") ?? "";
  if (transform !== "") {
    const functions = transformFunctions(transform);
    if (functions === null) issue(record.unsupported, "SVG_TRANSFORM_INVALID");
    else for (const name of functions) {
      if (name === "translate" || name === "scale") continue;
      if (name === "rotate") addMinimum(record, 5, "transform.rotate");
      else issue(record.unsupported, "SVG_UNSUPPORTED_TRANSFORM");
    }
  }

  if (GEOMETRY_ELEMENTS.has(name)) validateGeometry(element, record);
  if (name === "path" && (element.getAttribute("d") ?? "").trim() === "") {
    issue(record.unsupported, "SVG_PATH_DATA_INVALID");
  }
  if (name === "use") {
    const href = element.getAttribute("href") ?? element.getAttributeNS(XLINK_NAMESPACE, "href") ?? "";
    if (!href.startsWith("#") || href.length === 1) {
      if (href !== "") issue(record.unsafe, "SVG_EXTERNAL_REFERENCE");
      else issue(record.unsupported, "SVG_REFERENCE_INVALID");
    } else record.references.add(href.slice(1));
  }
  const children = elementChildren(element);
  if (name === "g") {
    const childNames = new Set(children.map((child) => child.localName));
    const v1Shape = childNames.size === 1 && (childNames.has("path") || childNames.has("use"));
    if (!v1Shape) addMinimum(record, 5, "group.mixed_or_nested_children");
  }
  if (name === "defs") {
    for (const child of children) {
      if (GEOMETRY_ELEMENTS.has(child.localName)) addMinimum(record, 5, "definition.basic_geometry");
    }
  }
  for (const child of children) inspectElement(child, record, ids);
}

/** @param {any} root @param {ProjectionRecord} record */
function inspectAccessibility(root, record) {
  const children = elementChildren(root);
  const title = children.find((child) => child.localName === "title");
  const desc = children.find((child) => child.localName === "desc");
  const titleText = title === undefined ? "" : textContent(title);
  const descText = desc === undefined ? "" : textContent(desc);
  const labelledBy = (root.getAttribute("aria-labelledby") ?? "").trim();
  const exactLabelled = titleText !== "" && descText !== "" && title?.getAttribute("id") !== "" && desc?.getAttribute("id") !== "" && labelledBy === `${title?.getAttribute("id")} ${desc?.getAttribute("id")}`;
  if (exactLabelled) return;
  addMinimum(record, 2, "accessibility.ownership");
  if (root.getAttribute("aria-hidden") === "true" && titleText === "" && descText === "") {
    issue(record.normalizations, "declare_decorative");
  } else if (titleText !== "") {
    issue(record.normalizations, descText === "" ? "title_only_to_labelled" : "labelled_ids_and_references");
  } else {
    issue(record.normalizations, "accessibility_authority_required");
  }
}

/** @param {string} text @param {Schema1Parser} parseSchema1 @returns {ProjectionRecord} */
export function classifySvg(text, parseSchema1) {
  const record = {
    schema1Compatible: false,
    minimumStage: 2,
    requiredFeatures: new Set(),
    normalizations: new Set(),
    unsupported: new Set(),
    unsafe: new Set(),
    references: new Set(),
  };
  const schema1 = parseSchema1(text);
  record.schema1Compatible = schema1.ok === true;
  if (record.schema1Compatible) record.minimumStage = 1;

  if (/<!DOCTYPE|<!ENTITY/i.test(text)) issue(record.unsafe, "XML_UNSAFE_DECLARATION");
  if (/<!\[CDATA\[/i.test(text)) issue(record.unsupported, "XML_UNSUPPORTED_CDATA");
  const withoutDeclaration = text.replace(/^\uFEFF?\s*<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])UTF-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/i, "");
  if (/<\?(?!xml\b)/i.test(withoutDeclaration) || /<\?xml\b/i.test(withoutDeclaration)) issue(record.unsupported, "XML_UNSUPPORTED_PROCESSING_INSTRUCTION");

  const errors = [];
  let document;
  try {
    document = new DOMParser({ onError: (level, message) => errors.push(`${level}:${message}`) }).parseFromString(text, "application/xml");
  } catch {
    issue(record.unsupported, "XML_SYNTAX");
    return record;
  }
  if (errors.length > 0 || document.documentElement === null) issue(record.unsupported, "XML_SYNTAX");
  const root = document.documentElement;
  if (root === null || root.localName !== "svg") {
    issue(record.unsupported, "SVG_INVALID_ROOT");
    return record;
  }
  const viewBox = (root.getAttribute("viewBox") ?? "").trim().split(/[\t\n\r ]+/).filter(Boolean);
  if (
    viewBox.length !== 4 ||
    viewBox.some((part) => !numeric(part)) ||
    Number(viewBox[2]) <= 0 ||
    Number(viewBox[3]) <= 0
  ) issue(record.unsupported, "SVG_VIEWBOX_INVALID");
  for (const field of ["width", "height"]) {
    if (root.hasAttribute(field) && (!numeric(root.getAttribute(field)) || Number(root.getAttribute(field)) <= 0)) {
      issue(record.unsupported, "SVG_CANVAS_DIMENSION_INVALID");
    }
  }
  const role = root.getAttribute("role") ?? "";
  if (role !== "" && role !== "img") issue(record.unsupported, "SVG_ACCESSIBILITY_INVALID");
  const hidden = root.getAttribute("aria-hidden") ?? "";
  if (hidden !== "" && hidden !== "true" && hidden !== "false") issue(record.unsupported, "SVG_ACCESSIBILITY_INVALID");
  const focusable = root.getAttribute("focusable") ?? "";
  if (focusable !== "" && focusable !== "true" && focusable !== "false") issue(record.unsupported, "SVG_ACCESSIBILITY_INVALID");
  const shapeRendering = root.getAttribute("shape-rendering") ?? "";
  if (shapeRendering !== "" && !["auto", "optimizeSpeed", "crispEdges", "geometricPrecision"].includes(shapeRendering)) {
    issue(record.unsupported, "SVG_SHAPE_RENDERING_INVALID");
  }
  inspectAccessibility(root, record);
  const ids = new Map();
  inspectElement(root, record, ids);
  for (const reference of record.references) {
    if (!ids.has(reference)) issue(record.unsupported, "SVG_REFERENCE_UNRESOLVED");
  }

  const version = root.getAttribute("version") ?? "";
  if (version !== "" && version !== "1.0" && version !== "1.1") issue(record.unsupported, "SVG_UNSUPPORTED_VERSION");
  if (version === "1.0" || version === "1.1") issue(record.normalizations, "canonicalize_svg_version");
  const children = elementChildren(root);
  if (!children.some((child) => !["title", "desc", "metadata", "defs"].includes(child.localName))) {
    issue(record.unsupported, "SVG_MISSING_ARTWORK");
  }
  if (children.filter((child) => child.localName === "title").length > 1 || children.filter((child) => child.localName === "desc").length > 1) {
    issue(record.unsupported, "SVG_ACCESSIBILITY_INVALID");
  }
  const firstArtwork = children.findIndex((child) => !["title", "desc", "metadata", "defs"].includes(child.localName));
  const defsIndex = children.findIndex((child) => child.localName === "defs");
  if (defsIndex !== -1 && firstArtwork !== -1 && defsIndex > firstArtwork) {
    addMinimum(record, 5, "definitions.forward_order");
    issue(record.normalizations, "canonicalize_definition_order");
  }
  return record;
}

/** @param {ProjectionRecord} record @param {number} stageNumber */
function stageClassification(record, stageNumber) {
  if (record.unsafe.size > 0) return "unsafe";
  if (stageNumber === 1) return record.schema1Compatible ? "directlyImportable" : "unsupported";
  if (record.unsupported.size > 0 || record.minimumStage > stageNumber) return "unsupported";
  return record.normalizations.size === 0 ? "directlyImportable" : "importableWithNormalization";
}

/** @param {Record<string, string[]>} groups @param {string} key @param {string} path */
function addSample(groups, key, path) {
  const existing = groups[key] ?? [];
  if (existing.length < SAMPLE_LIMIT) groups[key] = [...existing, path];
}

/** @param {CorpusInput} input @param {Schema1Parser} parseSchema1 */
export async function projectCorpus(input, parseSchema1) {
  const root = resolve(input.path);
  const paths = await svgPaths(root);
  /** @type {Map<string, string[]>} */
  const assetIds = new Map();
  /** @type {Map<string, string[]>} */
  const portablePaths = new Map();
  let invalidAssetIdentities = 0;
  for (const path of paths) {
    const id = deriveAssetId(path);
    if (id === null) invalidAssetIdentities += 1;
    else assetIds.set(id, [...(assetIds.get(id) ?? []), path]);
    const portable = path.normalize("NFC").toLocaleLowerCase("en-US");
    portablePaths.set(portable, [...(portablePaths.get(portable) ?? []), path]);
  }
  const stages = /** @type {any[]} */ (PROJECTION_STAGES.map((stage) => ({
    id: stage.id,
    directlyImportable: 0,
    importableWithNormalization: 0,
    unsupported: 0,
    unsafe: 0,
    diagnosticFiles: {},
    diagnosticSamples: {},
    normalizationFiles: {},
    normalizationSamples: {},
  })));
  let sourceBytes = 0;
  let overPerFileLimit = 0;
  let combinedFeatureFiles = 0;
  for (const path of paths) {
    const bytes = await readFile(join(root, path));
    sourceBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES) {
      overPerFileLimit += 1;
      for (const stage of stages) {
        stage.unsupported += 1;
        stage.diagnosticFiles.ANALYZE_FILE_LIMIT = (stage.diagnosticFiles.ANALYZE_FILE_LIMIT ?? 0) + 1;
        addSample(stage.diagnosticSamples, "ANALYZE_FILE_LIMIT", path);
      }
      continue;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      for (const stage of stages) {
        stage.unsupported += 1;
        stage.diagnosticFiles.XML_INVALID_UTF8 = (stage.diagnosticFiles.XML_INVALID_UTF8 ?? 0) + 1;
        addSample(stage.diagnosticSamples, "XML_INVALID_UTF8", path);
      }
      continue;
    }
    const record = classifySvg(text, (source) => parseSchema1(source, path));
    if (record.requiredFeatures.size >= 2) combinedFeatureFiles += 1;
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      if (stage === undefined) throw new Error("Projection stage index is out of range.");
      const classification = stageClassification(record, index + 1);
      stage[classification] += 1;
      const diagnostics = record.unsafe.size > 0 ? record.unsafe : record.unsupported.size > 0 ? record.unsupported : record.minimumStage > index + 1 ? record.requiredFeatures : new Set();
      for (const code of diagnostics) {
        stage.diagnosticFiles[code] = (stage.diagnosticFiles[code] ?? 0) + 1;
        addSample(stage.diagnosticSamples, code, path);
      }
      if (classification === "importableWithNormalization") {
        for (const code of record.normalizations) {
          stage.normalizationFiles[code] = (stage.normalizationFiles[code] ?? 0) + 1;
          addSample(stage.normalizationSamples, code, path);
        }
      }
    }
  }
  return {
    id: input.id,
    repository: { origin: input.origin, revision: input.revision },
    source: { svgCount: paths.length, sourceBytes, overPerFileLimit },
    identity: {
      invalidAssetIdentities,
      assetIdCollisions: collisionSummary(assetIds),
      portablePathCollisions: collisionSummary(portablePaths),
    },
    combinedFeatureFiles,
    stages,
  };
}

/** @param {CorpusInput[]} inputs @param {Schema1Parser} parseSchema1 */
export async function buildProjection(inputs, parseSchema1) {
  const corpora = [];
  for (const input of [...inputs].sort((left, right) => compareText(left.id, right.id))) {
    corpora.push(await projectCorpus(input, parseSchema1));
  }
  return {
    schema: "tfsb-v0.3-compatibility-projection",
    schemaVersion: 1,
    profile: "tfsb-svg-common-v0.3",
    authority: {
      counts: "provisional_projection_bounds",
      authoritativeProducer: "tfsb-analyze-v1",
      discrepancyDisposition: "stop_and_update_reviewed_architecture_and_projection",
      constraintsNotEvaluated: [
        "complete_accessibility_and_element_placement",
        "complete_id_grammar",
        "complete_path_data_grammar",
        "complete_presentation_numeric_and_enum_values",
        "complete_transform_arguments_and_arity",
        "definition_authority_and_reference_cycles",
        "gradient_and_local_paint_reference_contracts",
        "profile_group_depth_and_modeled_element_bounds",
      ],
    },
    sampleLimit: SAMPLE_LIMIT,
    stages: PROJECTION_STAGES,
    corpora,
  };
}

/** @param {string[]} argv */
function parseArguments(argv) {
  /** @type {CorpusInput[]} */
  const corpora = [];
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--corpus" && argv[index + 1] !== undefined) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("Missing --corpus value.");
      corpora.push(JSON.parse(value));
      index += 1;
    } else if (argv[index] === "--output" && argv[index + 1] !== undefined) {
      output = argv[index + 1];
      index += 1;
    } else throw new Error(`Unknown or incomplete argument '${argv[index] ?? ""}'.`);
  }
  if (corpora.length === 0 || output === undefined) throw new Error("At least one --corpus and one --output are required.");
  return { corpora, output };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const product = await import(new URL("../dist/index.js", import.meta.url).href);
  const projection = await buildProjection(options.corpora, product.parseSvg);
  const json = stableJson(projection);
  await writeFile(options.output, json, "utf8");
  process.stderr.write(`projected ${projection.corpora.length} corpus exports; sha256=${createHash("sha256").update(json).digest("hex")}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
