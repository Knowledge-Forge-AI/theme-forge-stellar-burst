import { parse as parseToml, TomlError } from "smol-toml";

import { fail, fromCaught, ok, type DiagnosticContext } from "./diagnostics.js";
import {
  formatNumber,
  normalizeText,
  parseAssetId,
  parseFiniteNumber,
  parseHexColor,
  parseLocalId,
  parseNumberText,
  parsePathData,
  parseProjectRelativePath,
  parseSvgFilename,
} from "./primitives.js";
import type {
  ArtworkElementV2,
  DefinitionsV2,
  ElementPresentationV2,
  NormalizedAssetV2,
  NormalizedProjectV2,
  PaintV2,
  PresentationV2,
  TransformOperationV2,
} from "./schema2-types.js";
import { validateAssetV2 } from "./schema2-validation.js";
import type { GradientStop, LinearGradient, Result, ShapeRendering } from "./types.js";

type UnknownRecord = Record<string, unknown>;

const PRESENTATION_KEYS = [
  "fill", "fill_gradient", "fill_fallback", "stroke", "stroke_gradient", "stroke_fallback",
  "stroke_width", "stroke_linecap", "stroke_linejoin", "stroke_miterlimit", "opacity",
  "fill_opacity", "stroke_opacity", "fill_rule", "clip_rule",
] as const;
const ELEMENT_BASE_KEYS = ["id", "transforms", "aria_hidden", ...PRESENTATION_KEYS] as const;
const DEFINITION_KINDS = ["groups", "paths", "circles", "ellipses", "rects", "lines", "polylines", "polygons"] as const;

function context(domain: "project-toml" | "asset-toml", source?: string): DiagnosticContext {
  return { operation: "parse", domain, ...(source === undefined ? {} : { source }) };
}

function asRecord(value: unknown, ctx: DiagnosticContext, location: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML table.", location);
  }
  return value as UnknownRecord;
}

function asArray(value: unknown, ctx: DiagnosticContext, location: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML array.", location);
  return value;
}

function asString(value: unknown, ctx: DiagnosticContext, location: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a non-empty string.", location);
  }
  return value;
}

function required(record: UnknownRecord, key: string, ctx: DiagnosticContext, location: string): unknown {
  if (!Object.hasOwn(record, key)) fail(ctx, "SCHEMA_MISSING_KEY", `Missing required key '${key}'.`, location);
  return record[key];
}

function expectKeys(record: UnknownRecord, allowed: readonly string[], ctx: DiagnosticContext, location: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    fail(ctx, "SCHEMA_UNKNOWN_KEY", `Unknown schema-2 key '${unknown}'.`, location === "" ? unknown : `${location}.${unknown}`);
  }
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], ctx: DiagnosticContext, location: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(ctx, "SCHEMA_INVALID_ENUM", `Expected one of: ${allowed.join(", ")}.`, location);
  }
  return value as T;
}

function parseBoolean(value: unknown, ctx: DiagnosticContext, location: string): boolean {
  if (typeof value !== "boolean") fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a boolean.", location);
  return value;
}

function parseUnit(value: unknown, ctx: DiagnosticContext, location: string, minimum = 0, maximum = 1): number {
  const number = parseFiniteNumber(value, ctx, location);
  if (number < minimum || number > maximum) {
    fail(ctx, "SCHEMA_INVALID_RANGE", `Expected a number in [${minimum}, ${maximum}].`, location);
  }
  return number;
}

function parsePaintV2(record: UnknownRecord, field: "fill" | "stroke", ctx: DiagnosticContext, location: string): PaintV2 | undefined {
  const raw = record[field];
  const gradient = record[`${field}_gradient`];
  const fallback = record[`${field}_fallback`];
  if (raw !== undefined && gradient !== undefined) {
    fail(ctx, "SCHEMA_INVALID_COMBINATION", `${field} and ${field}_gradient are mutually exclusive.`, location);
  }
  if (gradient !== undefined) {
    return {
      type: "linear-gradient",
      reference: parseLocalId(gradient, ctx, `${location}_gradient`),
      ...(fallback === undefined ? {} : { fallback: parseHexColor(fallback, ctx, `${location}_fallback`) }),
    };
  }
  if (fallback !== undefined) fail(ctx, "SCHEMA_INVALID_PAINT_FALLBACK", "A fallback requires a typed gradient reference.", `${location}_fallback`);
  if (raw === undefined) return undefined;
  if (raw === "none") return { type: "none" };
  if (raw === "currentColor") return { type: "currentColor" };
  return { type: "solid", color: parseHexColor(raw, ctx, location) };
}

function parsePresentation(record: UnknownRecord, ctx: DiagnosticContext, location: string, element: boolean): ElementPresentationV2 {
  const strokeWidth = record.stroke_width === undefined ? undefined : parseFiniteNumber(record.stroke_width, ctx, `${location}.stroke_width`);
  if (strokeWidth !== undefined && strokeWidth < 0) fail(ctx, "SCHEMA_INVALID_RANGE", "stroke_width must be non-negative.", `${location}.stroke_width`);
  const miter = record.stroke_miterlimit === undefined ? undefined : parseFiniteNumber(record.stroke_miterlimit, ctx, `${location}.stroke_miterlimit`);
  if (miter !== undefined && miter < 1) fail(ctx, "SCHEMA_INVALID_RANGE", "stroke_miterlimit must be at least 1.", `${location}.stroke_miterlimit`);
  return {
    ...(parsePaintV2(record, "fill", ctx, `${location}.fill`) === undefined ? {} : { fill: parsePaintV2(record, "fill", ctx, `${location}.fill`)! }),
    ...(parsePaintV2(record, "stroke", ctx, `${location}.stroke`) === undefined ? {} : { stroke: parsePaintV2(record, "stroke", ctx, `${location}.stroke`)! }),
    ...(strokeWidth === undefined ? {} : { strokeWidth }),
    ...(record.stroke_linecap === undefined ? {} : { strokeLinecap: parseEnum(record.stroke_linecap, ["butt", "round", "square"], ctx, `${location}.stroke_linecap`) }),
    ...(record.stroke_linejoin === undefined ? {} : { strokeLinejoin: parseEnum(record.stroke_linejoin, ["miter", "round", "bevel"], ctx, `${location}.stroke_linejoin`) }),
    ...(miter === undefined ? {} : { strokeMiterlimit: miter }),
    ...(record.opacity === undefined ? {} : { opacity: parseUnit(record.opacity, ctx, `${location}.opacity`) }),
    ...(record.fill_opacity === undefined ? {} : { fillOpacity: parseUnit(record.fill_opacity, ctx, `${location}.fill_opacity`) }),
    ...(record.stroke_opacity === undefined ? {} : { strokeOpacity: parseUnit(record.stroke_opacity, ctx, `${location}.stroke_opacity`) }),
    ...(record.fill_rule === undefined ? {} : { fillRule: parseEnum(record.fill_rule, ["nonzero", "evenodd"], ctx, `${location}.fill_rule`) }),
    ...(record.clip_rule === undefined ? {} : { clipRule: parseEnum(record.clip_rule, ["nonzero", "evenodd"], ctx, `${location}.clip_rule`) }),
    ...(element && record.aria_hidden !== undefined ? { ariaHidden: parseBoolean(record.aria_hidden, ctx, `${location}.aria_hidden`) } : {}),
  };
}

function parseTransforms(value: unknown, ctx: DiagnosticContext, location: string): readonly TransformOperationV2[] | undefined {
  if (value === undefined) return undefined;
  const values = asArray(value, ctx, location);
  if (values.length === 0) fail(ctx, "SCHEMA_INVALID_RANGE", "transforms cannot be empty.", location);
  return values.map((item, index) => {
    const itemLocation = `${location}[${index}]`;
    const record = asRecord(item, ctx, itemLocation);
    const type = parseEnum(required(record, "type", ctx, `${itemLocation}.type`), ["translate", "scale", "rotate"], ctx, `${itemLocation}.type`);
    if (type === "rotate") {
      expectKeys(record, ["type", "angle", "cx", "cy"], ctx, itemLocation);
      const hasCx = record.cx !== undefined;
      const hasCy = record.cy !== undefined;
      if (hasCx !== hasCy) fail(ctx, "SCHEMA_INVALID_TRANSFORM", "rotate requires both cx and cy or neither.", itemLocation);
      return {
        type,
        angle: parseFiniteNumber(required(record, "angle", ctx, `${itemLocation}.angle`), ctx, `${itemLocation}.angle`),
        ...(hasCx ? { cx: parseFiniteNumber(record.cx, ctx, `${itemLocation}.cx`), cy: parseFiniteNumber(record.cy, ctx, `${itemLocation}.cy`) } : {}),
      };
    }
    expectKeys(record, ["type", "x", "y"], ctx, itemLocation);
    const x = parseFiniteNumber(required(record, "x", ctx, `${itemLocation}.x`), ctx, `${itemLocation}.x`);
    const y = record.y === undefined ? undefined : parseFiniteNumber(record.y, ctx, `${itemLocation}.y`);
    return { type, x, ...(y === undefined || y === (type === "translate" ? 0 : x) ? {} : { y }) };
  });
}

function parsePoints(value: unknown, minimum: number, ctx: DiagnosticContext, location: string): readonly (readonly [number, number])[] {
  const points = asArray(value, ctx, location);
  if (points.length < minimum) fail(ctx, "SCHEMA_INVALID_RANGE", `Expected at least ${minimum} point pairs.`, location);
  return points.map((point, index) => {
    const pair = asArray(point, ctx, `${location}[${index}]`);
    if (pair.length !== 2) fail(ctx, "SCHEMA_INVALID_TYPE", "Expected an [x, y] pair.", `${location}[${index}]`);
    return [parseFiniteNumber(pair[0], ctx, `${location}[${index}][0]`), parseFiniteNumber(pair[1], ctx, `${location}[${index}][1]`)] as const;
  });
}

function parseElement(value: unknown, ctx: DiagnosticContext, location: string, requireId = false): ArtworkElementV2 {
  const record = asRecord(value, ctx, location);
  const type = parseEnum(required(record, "type", ctx, `${location}.type`), ["path", "use", "circle", "ellipse", "rect", "line", "polyline", "polygon", "group"], ctx, `${location}.type`);
  const id = record.id === undefined ? undefined : parseLocalId(record.id, ctx, `${location}.id`);
  if (requireId && id === undefined) fail(ctx, "SCHEMA_MISSING_KEY", "Definitions require id.", `${location}.id`);
  const base = {
    ...parsePresentation(record, ctx, location, true),
    ...(id === undefined ? {} : { id }),
    ...(parseTransforms(record.transforms, ctx, `${location}.transforms`) === undefined ? {} : { transforms: parseTransforms(record.transforms, ctx, `${location}.transforms`)! }),
  };
  if (type === "path") {
    expectKeys(record, ["type", ...ELEMENT_BASE_KEYS, "d"], ctx, location);
    return { type, ...base, d: parsePathData(required(record, "d", ctx, `${location}.d`), ctx, `${location}.d`) };
  }
  if (type === "use") {
    expectKeys(record, ["type", ...ELEMENT_BASE_KEYS, "reference", "x", "y"], ctx, location);
    return { type, ...base, reference: parseLocalId(required(record, "reference", ctx, `${location}.reference`), ctx, `${location}.reference`), ...(record.x === undefined ? {} : { x: parseFiniteNumber(record.x, ctx, `${location}.x`) }), ...(record.y === undefined ? {} : { y: parseFiniteNumber(record.y, ctx, `${location}.y`) }) };
  }
  if (type === "circle") {
    expectKeys(record, ["type", ...ELEMENT_BASE_KEYS, "cx", "cy", "r"], ctx, location);
    const r = parseFiniteNumber(required(record, "r", ctx, `${location}.r`), ctx, `${location}.r`);
    if (r <= 0) fail(ctx, "SCHEMA_INVALID_RANGE", "circle r must be positive.", `${location}.r`);
    return { type, ...base, cx: parseFiniteNumber(required(record, "cx", ctx, `${location}.cx`), ctx, `${location}.cx`), cy: parseFiniteNumber(required(record, "cy", ctx, `${location}.cy`), ctx, `${location}.cy`), r };
  }
  if (type === "ellipse") {
    expectKeys(record, ["type", ...ELEMENT_BASE_KEYS, "cx", "cy", "rx", "ry"], ctx, location);
    const rx = parseFiniteNumber(required(record, "rx", ctx, `${location}.rx`), ctx, `${location}.rx`);
    const ry = parseFiniteNumber(required(record, "ry", ctx, `${location}.ry`), ctx, `${location}.ry`);
    if (rx <= 0 || ry <= 0) fail(ctx, "SCHEMA_INVALID_RANGE", "ellipse radii must be positive.", location);
    return { type, ...base, cx: parseFiniteNumber(required(record, "cx", ctx, `${location}.cx`), ctx, `${location}.cx`), cy: parseFiniteNumber(required(record, "cy", ctx, `${location}.cy`), ctx, `${location}.cy`), rx, ry };
  }
  if (type === "rect") {
    expectKeys(record, ["type", ...ELEMENT_BASE_KEYS, "x", "y", "width", "height", "corner_radius", "corner_radii"], ctx, location);
    const width = parseFiniteNumber(required(record, "width", ctx, `${location}.width`), ctx, `${location}.width`);
    const height = parseFiniteNumber(required(record, "height", ctx, `${location}.height`), ctx, `${location}.height`);
    if (width <= 0 || height <= 0) fail(ctx, "SCHEMA_INVALID_RANGE", "rect width and height must be positive.", location);
    if (record.corner_radius !== undefined && record.corner_radii !== undefined) fail(ctx, "SCHEMA_INVALID_COMBINATION", "Use corner_radius or corner_radii, not both.", location);
    let cornerRadius: number | undefined;
    let cornerRadii: readonly [number, number] | undefined;
    if (record.corner_radius !== undefined) cornerRadius = parseFiniteNumber(record.corner_radius, ctx, `${location}.corner_radius`);
    if (record.corner_radii !== undefined) {
      const pair = asArray(record.corner_radii, ctx, `${location}.corner_radii`);
      if (pair.length !== 2) fail(ctx, "SCHEMA_INVALID_TYPE", "corner_radii must contain [rx, ry].", `${location}.corner_radii`);
      cornerRadii = [parseFiniteNumber(pair[0], ctx, `${location}.corner_radii[0]`), parseFiniteNumber(pair[1], ctx, `${location}.corner_radii[1]`)];
    }
    const rx = cornerRadius ?? cornerRadii?.[0];
    const ry = cornerRadius ?? cornerRadii?.[1];
    if ((rx !== undefined && (rx < 0 || rx > width / 2)) || (ry !== undefined && (ry < 0 || ry > height / 2))) fail(ctx, "SCHEMA_INVALID_RANGE", "rect corner radii exceed SVG bounds.", location);
    return { type, ...base, x: parseFiniteNumber(required(record, "x", ctx, `${location}.x`), ctx, `${location}.x`), y: parseFiniteNumber(required(record, "y", ctx, `${location}.y`), ctx, `${location}.y`), width, height, ...(cornerRadius === undefined ? {} : { cornerRadius }), ...(cornerRadii === undefined ? {} : { cornerRadii }) };
  }
  if (type === "line") {
    expectKeys(record, ["type", ...ELEMENT_BASE_KEYS, "x1", "y1", "x2", "y2"], ctx, location);
    return { type, ...base, x1: parseFiniteNumber(required(record, "x1", ctx, `${location}.x1`), ctx, `${location}.x1`), y1: parseFiniteNumber(required(record, "y1", ctx, `${location}.y1`), ctx, `${location}.y1`), x2: parseFiniteNumber(required(record, "x2", ctx, `${location}.x2`), ctx, `${location}.x2`), y2: parseFiniteNumber(required(record, "y2", ctx, `${location}.y2`), ctx, `${location}.y2`) };
  }
  if (type === "polyline" || type === "polygon") {
    expectKeys(record, ["type", ...ELEMENT_BASE_KEYS, "points"], ctx, location);
    return { type, ...base, points: parsePoints(required(record, "points", ctx, `${location}.points`), type === "polyline" ? 2 : 3, ctx, `${location}.points`) };
  }
  expectKeys(record, ["type", ...ELEMENT_BASE_KEYS, "children"], ctx, location);
  const children = asArray(required(record, "children", ctx, `${location}.children`), ctx, `${location}.children`);
  if (children.length === 0) fail(ctx, "SCHEMA_INVALID_RANGE", "Groups cannot be empty.", `${location}.children`);
  return { type, ...base, children: children.map((child, index) => parseElement(child, ctx, `${location}.children[${index}]`)) };
}

function parseGradientStop(value: unknown, ctx: DiagnosticContext, location: string): GradientStop {
  const record = asRecord(value, ctx, location);
  expectKeys(record, ["offset", "color", "opacity"], ctx, location);
  return { offset: parseUnit(required(record, "offset", ctx, `${location}.offset`), ctx, `${location}.offset`), color: parseHexColor(required(record, "color", ctx, `${location}.color`), ctx, `${location}.color`), ...(record.opacity === undefined ? {} : { opacity: parseUnit(record.opacity, ctx, `${location}.opacity`) }) };
}

function parseGradient(value: unknown, ctx: DiagnosticContext, location: string): LinearGradient {
  const record = asRecord(value, ctx, location);
  expectKeys(record, ["id", "x1", "y1", "x2", "y2", "units", "stops"], ctx, location);
  const stops = asArray(required(record, "stops", ctx, `${location}.stops`), ctx, `${location}.stops`);
  if (stops.length < 2) fail(ctx, "SCHEMA_INVALID_RANGE", "A linear gradient requires at least two stops.", `${location}.stops`);
  return { id: parseLocalId(required(record, "id", ctx, `${location}.id`), ctx, `${location}.id`), x1: parseFiniteNumber(required(record, "x1", ctx, `${location}.x1`), ctx, `${location}.x1`), y1: parseFiniteNumber(required(record, "y1", ctx, `${location}.y1`), ctx, `${location}.y1`), x2: parseFiniteNumber(required(record, "x2", ctx, `${location}.x2`), ctx, `${location}.x2`), y2: parseFiniteNumber(required(record, "y2", ctx, `${location}.y2`), ctx, `${location}.y2`), ...(record.units === undefined ? {} : { units: parseEnum(record.units, ["userSpaceOnUse"], ctx, `${location}.units`) }), stops: stops.map((stop, index) => parseGradientStop(stop, ctx, `${location}.stops[${index}]`)) };
}

function emptyDefinitions(): DefinitionsV2 {
  return { linearGradients: [], groups: [], paths: [], circles: [], ellipses: [], rects: [], lines: [], polylines: [], polygons: [] };
}

function parseDefinitions(value: unknown, ctx: DiagnosticContext): DefinitionsV2 {
  if (value === undefined) return emptyDefinitions();
  const record = asRecord(value, ctx, "definitions");
  expectKeys(record, ["linear_gradients", ...DEFINITION_KINDS], ctx, "definitions");
  const result = emptyDefinitions();
  const linearGradients = record.linear_gradients === undefined ? [] : asArray(record.linear_gradients, ctx, "definitions.linear_gradients").map((item, index) => parseGradient(item, ctx, `definitions.linear_gradients[${index}]`));
  const parseKind = <K extends keyof DefinitionsV2>(key: K, expected: ArtworkElementV2["type"]): DefinitionsV2[K] => {
    const raw = record[key] === undefined ? [] : asArray(record[key], ctx, `definitions.${key}`);
    return raw.map((item, index) => {
      const element = parseElement(item, ctx, `definitions.${key}[${index}]`, true);
      if (element.type !== expected) fail(ctx, "SCHEMA_INVALID_DEFINITION_TYPE", `Definition category '${key}' requires type '${expected}'.`, `definitions.${key}[${index}].type`);
      return element;
    }) as unknown as DefinitionsV2[K];
  };
  return { ...result, linearGradients, groups: parseKind("groups", "group"), paths: parseKind("paths", "path"), circles: parseKind("circles", "circle"), ellipses: parseKind("ellipses", "ellipse"), rects: parseKind("rects", "rect"), lines: parseKind("lines", "line"), polylines: parseKind("polylines", "polyline"), polygons: parseKind("polygons", "polygon") };
}

function parseProjectRoot(root: UnknownRecord, ctx: DiagnosticContext): NormalizedProjectV2 {
  if (required(root, "schema_version", ctx, "schema_version") !== 2) fail(ctx, "SCHEMA_UNSUPPORTED_VERSION", "Expected integer schema_version = 2.", "schema_version");
  expectKeys(root, ["schema_version", "name", "build", "install", "companion"], ctx, "");
  const build = asRecord(required(root, "build", ctx, "build"), ctx, "build");
  expectKeys(build, ["directory"], ctx, "build");
  const installs = (root.install === undefined ? [] : asArray(root.install, ctx, "install")).map((item, index) => {
    const location = `install[${index}]`;
    const record = asRecord(item, ctx, location);
    expectKeys(record, ["asset", "destinations"], ctx, location);
    const destinations = asArray(required(record, "destinations", ctx, `${location}.destinations`), ctx, `${location}.destinations`);
    if (destinations.length === 0) fail(ctx, "SCHEMA_INVALID_RANGE", "Install destinations cannot be empty.", `${location}.destinations`);
    return { asset: parseAssetId(required(record, "asset", ctx, `${location}.asset`), ctx, `${location}.asset`), destinations: destinations.map((destination, destinationIndex) => parseProjectRelativePath(destination, ctx, `${location}.destinations[${destinationIndex}]`)) };
  });
  const companions = (root.companion === undefined ? [] : asArray(root.companion, ctx, "companion")).map((item, index) => {
    const location = `companion[${index}]`;
    const record = asRecord(item, ctx, location);
    expectKeys(record, ["file", "destinations"], ctx, location);
    const destinations = asArray(required(record, "destinations", ctx, `${location}.destinations`), ctx, `${location}.destinations`);
    if (destinations.length === 0) fail(ctx, "SCHEMA_INVALID_RANGE", "Companion destinations cannot be empty.", `${location}.destinations`);
    return { file: parseProjectRelativePath(required(record, "file", ctx, `${location}.file`), ctx, `${location}.file`), destinations: destinations.map((destination, destinationIndex) => parseProjectRelativePath(destination, ctx, `${location}.destinations[${destinationIndex}]`)) };
  });
  const name = asString(required(root, "name", ctx, "name"), ctx, "name");
  if (name.trim() === "") fail(ctx, "SCHEMA_INVALID_TEXT", "Project name cannot be blank.", "name");
  return { schemaVersion: 2, name, buildDirectory: parseProjectRelativePath(required(build, "directory", ctx, "build.directory"), ctx, "build.directory"), installs, companions };
}

export function parseProjectTomlV2(text: string, source?: string): Result<NormalizedProjectV2> {
  const ctx = context("project-toml", source);
  try { return ok(parseProjectRoot(asRecord(parseToml(text.replace(/^\uFEFF/, "")), ctx, ""), ctx)); }
  catch (error) { return fromCaught(error, ctx, "TOML_SYNTAX", "Invalid TOML syntax.", (caught) => caught instanceof TomlError); }
}

export function parseAssetTomlV2(text: string, source?: string): Result<NormalizedAssetV2> {
  const ctx = context("asset-toml", source);
  try {
    const root = asRecord(parseToml(text.replace(/^\uFEFF/, "")), ctx, "");
    if (required(root, "schema_version", ctx, "schema_version") !== 2) fail(ctx, "SCHEMA_UNSUPPORTED_VERSION", "Expected integer schema_version = 2.", "schema_version");
    expectKeys(root, ["schema_version", "id", "filename", "metadata_text", "canvas", "accessibility", "presentation", "definitions", "elements"], ctx, "");
    const id = parseAssetId(required(root, "id", ctx, "id"), ctx, "id");
    const canvasRecord = asRecord(required(root, "canvas", ctx, "canvas"), ctx, "canvas");
    expectKeys(canvasRecord, ["width", "height", "view_box", "shape_rendering"], ctx, "canvas");
    const viewBoxParts = asString(required(canvasRecord, "view_box", ctx, "canvas.view_box"), ctx, "canvas.view_box").trim().split(/[\t\n\r ]+/);
    if (viewBoxParts.length !== 4) fail(ctx, "SCHEMA_INVALID_VIEW_BOX", "view_box must contain four numbers.", "canvas.view_box");
    const viewBox = viewBoxParts.map((part) => parseNumberText(part, ctx, "canvas.view_box")) as [number, number, number, number];
    if (viewBox[2] <= 0 || viewBox[3] <= 0) fail(ctx, "SCHEMA_INVALID_RANGE", "view_box width and height must be positive.", "canvas.view_box");
    const width = canvasRecord.width === undefined ? undefined : parseFiniteNumber(canvasRecord.width, ctx, "canvas.width");
    const height = canvasRecord.height === undefined ? undefined : parseFiniteNumber(canvasRecord.height, ctx, "canvas.height");
    if ((width !== undefined && width <= 0) || (height !== undefined && height <= 0)) fail(ctx, "SCHEMA_INVALID_RANGE", "Canvas dimensions must be positive.", "canvas");
    const accessibilityRecord = asRecord(required(root, "accessibility", ctx, "accessibility"), ctx, "accessibility");
    const mode = parseEnum(required(accessibilityRecord, "mode", ctx, "accessibility.mode"), ["labelled", "decorative", "consumer_labelled"], ctx, "accessibility.mode");
    let accessibility;
    if (mode === "labelled") {
      expectKeys(accessibilityRecord, ["mode", "title", "title_id", "description", "description_id", "focusable"], ctx, "accessibility");
      const title = normalizeText(asString(required(accessibilityRecord, "title", ctx, "accessibility.title"), ctx, "accessibility.title"));
      if (title === "") fail(ctx, "SCHEMA_INVALID_TEXT", "labelled title cannot be blank.", "accessibility.title");
      const description = accessibilityRecord.description === undefined ? undefined : normalizeText(asString(accessibilityRecord.description, ctx, "accessibility.description"));
      if (description === "") fail(ctx, "SCHEMA_INVALID_TEXT", "description cannot be blank.", "accessibility.description");
      if (description === undefined && accessibilityRecord.description_id !== undefined) fail(ctx, "SCHEMA_INVALID_COMBINATION", "description_id requires description.", "accessibility.description_id");
      accessibility = { mode, title, titleId: parseLocalId(accessibilityRecord.title_id ?? `tfsb-${id}-title`, ctx, "accessibility.title_id"), ...(description === undefined ? {} : { description, descriptionId: parseLocalId(accessibilityRecord.description_id ?? `tfsb-${id}-description`, ctx, "accessibility.description_id") }), ...(accessibilityRecord.focusable === undefined ? {} : { focusable: parseBoolean(accessibilityRecord.focusable, ctx, "accessibility.focusable") }) } as const;
    } else {
      expectKeys(accessibilityRecord, ["mode", "focusable"], ctx, "accessibility");
      accessibility = { mode, ...(accessibilityRecord.focusable === undefined ? {} : { focusable: parseBoolean(accessibilityRecord.focusable, ctx, "accessibility.focusable") }) } as const;
    }
    const presentationRecord = root.presentation === undefined ? {} : asRecord(root.presentation, ctx, "presentation");
    expectKeys(presentationRecord, PRESENTATION_KEYS, ctx, "presentation");
    const elements = asArray(required(root, "elements", ctx, "elements"), ctx, "elements");
    if (elements.length === 0) fail(ctx, "SCHEMA_INVALID_RANGE", "An asset requires at least one artwork element.", "elements");
    const asset: NormalizedAssetV2 = { schemaVersion: 2, id, filename: parseSvgFilename(required(root, "filename", ctx, "filename"), ctx, "filename"), svg: { canvas: { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }), viewBox, ...(canvasRecord.shape_rendering === undefined || canvasRecord.shape_rendering === "auto" ? {} : { shapeRendering: parseEnum(canvasRecord.shape_rendering, ["optimizeSpeed", "crispEdges", "geometricPrecision"], ctx, "canvas.shape_rendering") as ShapeRendering }) }, accessibility, presentation: parsePresentation(presentationRecord, ctx, "presentation", false) as PresentationV2, ...(root.metadata_text === undefined ? {} : { metadataText: normalizeText(asString(root.metadata_text, ctx, "metadata_text", true)) }), definitions: parseDefinitions(root.definitions, ctx), elements: elements.map((element, index) => parseElement(element, ctx, `elements[${index}]`)) } };
    validateAssetV2(asset, ctx);
    return ok(asset);
  } catch (error) { return fromCaught(error, ctx, "TOML_SYNTAX", "Invalid TOML syntax.", (caught) => caught instanceof TomlError); }
}

function basicString(value: string): string { return JSON.stringify(value).replace(/\u007f/g, "\\u007F").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); }
function inline(fields: readonly string[]): string { return `{ ${fields.join(", ")} }`; }
function paintFields(value: PresentationV2, field: "fill" | "stroke"): string[] {
  const paint = value[field];
  if (paint === undefined) return [];
  if (paint.type === "linear-gradient") return [`${field}_gradient = ${basicString(paint.reference)}`, ...(paint.fallback === undefined ? [] : [`${field}_fallback = ${basicString(paint.fallback)}`])];
  return [`${field} = ${basicString(paint.type === "solid" ? paint.color : paint.type)}`];
}
function presentationFields(value: ElementPresentationV2, element = true): string[] {
  return [...paintFields(value, "fill"), ...paintFields(value, "stroke"), ...(value.strokeWidth === undefined ? [] : [`stroke_width = ${formatNumber(value.strokeWidth)}`]), ...(value.strokeLinecap === undefined ? [] : [`stroke_linecap = ${basicString(value.strokeLinecap)}`]), ...(value.strokeLinejoin === undefined ? [] : [`stroke_linejoin = ${basicString(value.strokeLinejoin)}`]), ...(value.strokeMiterlimit === undefined ? [] : [`stroke_miterlimit = ${formatNumber(value.strokeMiterlimit)}`]), ...(value.opacity === undefined ? [] : [`opacity = ${formatNumber(value.opacity)}`]), ...(element && value.ariaHidden !== undefined ? [`aria_hidden = ${value.ariaHidden ? "true" : "false"}`] : []), ...(value.fillOpacity === undefined ? [] : [`fill_opacity = ${formatNumber(value.fillOpacity)}`]), ...(value.strokeOpacity === undefined ? [] : [`stroke_opacity = ${formatNumber(value.strokeOpacity)}`]), ...(value.fillRule === undefined ? [] : [`fill_rule = ${basicString(value.fillRule)}`]), ...(value.clipRule === undefined ? [] : [`clip_rule = ${basicString(value.clipRule)}`])];
}
function transformFields(value: ArtworkElementV2): string[] {
  if (value.transforms === undefined) return [];
  const records = value.transforms.map((transform) => inline(transform.type === "rotate" ? [`type = "rotate"`, `angle = ${formatNumber(transform.angle)}`, ...(transform.cx === undefined ? [] : [`cx = ${formatNumber(transform.cx)}`, `cy = ${formatNumber(transform.cy!)}`])] : [`type = ${basicString(transform.type)}`, `x = ${formatNumber(transform.x)}`, ...(transform.y === undefined ? [] : [`y = ${formatNumber(transform.y)}`])]));
  return [`transforms = [${records.join(", ")}]`];
}
function inlineElement(value: ArtworkElementV2): string {
  return inline(elementFields(value, true));
}
function elementFields(value: ArtworkElementV2, compact = false): string[] {
  const base = [`type = ${basicString(value.type)}`, ...(value.id === undefined ? [] : [`id = ${basicString(value.id)}`]), ...presentationFields(value), ...transformFields(value)];
  let geometry: string[];
  if (value.type === "path") geometry = [`d = ${basicString(value.d)}`];
  else if (value.type === "use") geometry = [`reference = ${basicString(value.reference)}`, ...(value.x === undefined ? [] : [`x = ${formatNumber(value.x)}`]), ...(value.y === undefined ? [] : [`y = ${formatNumber(value.y)}`])];
  else if (value.type === "circle") geometry = [`cx = ${formatNumber(value.cx)}`, `cy = ${formatNumber(value.cy)}`, `r = ${formatNumber(value.r)}`];
  else if (value.type === "ellipse") geometry = [`cx = ${formatNumber(value.cx)}`, `cy = ${formatNumber(value.cy)}`, `rx = ${formatNumber(value.rx)}`, `ry = ${formatNumber(value.ry)}`];
  else if (value.type === "rect") geometry = [`x = ${formatNumber(value.x)}`, `y = ${formatNumber(value.y)}`, `width = ${formatNumber(value.width)}`, `height = ${formatNumber(value.height)}`, ...(value.cornerRadius === undefined ? [] : [`corner_radius = ${formatNumber(value.cornerRadius)}`]), ...(value.cornerRadii === undefined ? [] : [`corner_radii = [${value.cornerRadii.map(formatNumber).join(", ")}]`])];
  else if (value.type === "line") geometry = [`x1 = ${formatNumber(value.x1)}`, `y1 = ${formatNumber(value.y1)}`, `x2 = ${formatNumber(value.x2)}`, `y2 = ${formatNumber(value.y2)}`];
  else if (value.type === "polyline" || value.type === "polygon") geometry = [`points = [${value.points.map((point) => `[${point.map(formatNumber).join(", ")}]`).join(", ")}]`];
  else geometry = compact
    ? [`children = [${value.children.map(inlineElement).join(", ")}]`]
    : ["children = [", ...value.children.map((child) => `  ${inlineElement(child)},`), "]"];
  const fields = [...base, ...geometry];
  return compact ? fields.map((field) => field.replace(/\n/g, " ")) : fields;
}
function projectLines(project: NormalizedProjectV2): string[] {
  const lines = ["schema_version = 2", `name = ${basicString(project.name)}`, "", "[build]", `directory = ${basicString(project.buildDirectory)}`];
  for (const install of project.installs) lines.push("", "[[install]]", `asset = ${basicString(install.asset)}`, "destinations = [", ...install.destinations.map((value) => `  ${basicString(value)},`), "]");
  for (const companion of project.companions) lines.push("", "[[companion]]", `file = ${basicString(companion.file)}`, "destinations = [", ...companion.destinations.map((value) => `  ${basicString(value)},`), "]");
  return lines;
}
export function serializeProjectTomlV2(project: NormalizedProjectV2): string { return `${projectLines(project).join("\n")}\n`; }

export function serializeAssetTomlV2(asset: NormalizedAssetV2): string {
  const svg = asset.svg;
  const sections: string[][] = [["schema_version = 2", `id = ${basicString(asset.id)}`, `filename = ${basicString(asset.filename)}`, ...(svg.metadataText === undefined ? [] : [`metadata_text = ${basicString(svg.metadataText)}`])], ["[canvas]", ...(svg.canvas.width === undefined ? [] : [`width = ${formatNumber(svg.canvas.width)}`]), ...(svg.canvas.height === undefined ? [] : [`height = ${formatNumber(svg.canvas.height)}`]), `view_box = ${basicString(svg.canvas.viewBox.map(formatNumber).join(" "))}`, ...(svg.canvas.shapeRendering === undefined ? [] : [`shape_rendering = ${basicString(svg.canvas.shapeRendering)}`])], ["[accessibility]", `mode = ${basicString(svg.accessibility.mode)}`, ...(svg.accessibility.mode !== "labelled" ? [] : [`title = ${basicString(svg.accessibility.title)}`, `title_id = ${basicString(svg.accessibility.titleId)}`, ...(svg.accessibility.description === undefined ? [] : [`description = ${basicString(svg.accessibility.description)}`, `description_id = ${basicString(svg.accessibility.descriptionId!)}`])]), ...(svg.accessibility.focusable === undefined ? [] : [`focusable = ${svg.accessibility.focusable ? "true" : "false"}`])]];
  const rootPresentation = presentationFields(svg.presentation, false);
  if (rootPresentation.length > 0) sections.push(["[presentation]", ...rootPresentation]);
  for (const gradient of svg.definitions.linearGradients) sections.push(["[[definitions.linear_gradients]]", `id = ${basicString(gradient.id)}`, `x1 = ${formatNumber(gradient.x1)}`, `y1 = ${formatNumber(gradient.y1)}`, `x2 = ${formatNumber(gradient.x2)}`, `y2 = ${formatNumber(gradient.y2)}`, ...(gradient.units === undefined ? [] : [`units = ${basicString(gradient.units)}`]), "stops = [", ...gradient.stops.map((stop) => `  ${inline([`offset = ${formatNumber(stop.offset)}`, `color = ${basicString(stop.color)}`, ...(stop.opacity === undefined ? [] : [`opacity = ${formatNumber(stop.opacity)}`])])},`), "]"]);
  const categories: readonly [string, readonly ArtworkElementV2[]][] = [["groups", svg.definitions.groups], ["paths", svg.definitions.paths], ["circles", svg.definitions.circles], ["ellipses", svg.definitions.ellipses], ["rects", svg.definitions.rects], ["lines", svg.definitions.lines], ["polylines", svg.definitions.polylines], ["polygons", svg.definitions.polygons]];
  for (const [category, values] of categories) for (const value of values) sections.push([`[[definitions.${category}]]`, ...elementFields(value)]);
  for (const element of svg.elements) sections.push(["[[elements]]", ...elementFields(element)]);
  return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}
