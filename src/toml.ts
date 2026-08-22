import { parse as parseToml, TomlError } from "smol-toml";

import {
  fromCaught,
  ok,
  fail,
  type DiagnosticContext,
} from "./diagnostics.js";
import {
  normalizeText,
  parseAssetId,
  parseFiniteNumber,
  parseHexColor,
  parseLocalId,
  parseNumberText,
  parsePaint,
  parsePathData,
  parseProjectRelativePath,
  parseSvgFilename,
  parseTransform,
} from "./primitives.js";
import type {
  ArtworkElement,
  DefinitionPath,
  DefinitionGroup,
  Definitions,
  GradientStop,
  LinearGradient,
  NormalizedAsset,
  NormalizedProject,
  PathSpec,
  Presentation,
  Result,
  ShapeRendering,
  SvgDocument,
  UseSpec,
} from "./types.js";
import { validateSvgDocument } from "./validation.js";

type UnknownRecord = Record<string, unknown>;

const PRESENTATION_KEYS = [
  "fill",
  "fill_fallback",
  "stroke",
  "stroke_fallback",
  "stroke_width",
  "stroke_linecap",
  "stroke_linejoin",
  "stroke_miterlimit",
  "opacity",
  "aria_hidden",
] as const;

function context(
  domain: DiagnosticContext["domain"],
  source: string | undefined,
): DiagnosticContext {
  return { operation: "parse", domain, ...(source === undefined ? {} : { source }) };
}

function asRecord(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML table.", location);
  }
  return value as UnknownRecord;
}

function asArray(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a TOML array.", location);
  }
  return value;
}

function asString(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(ctx, "SCHEMA_INVALID_TYPE", "Expected a non-empty string.", location);
  }
  return value;
}

function required(record: UnknownRecord, key: string, ctx: DiagnosticContext, location: string): unknown {
  if (!Object.hasOwn(record, key)) {
    fail(ctx, "SCHEMA_MISSING_KEY", `Missing required key '${key}'.`, location);
  }
  return record[key];
}

function expectKeys(
  record: UnknownRecord,
  allowed: readonly string[],
  ctx: DiagnosticContext,
  location: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    fail(
      ctx,
      "SCHEMA_UNKNOWN_KEY",
      `Unknown schema-1 key '${unknown}'.`,
      location === "" ? unknown : `${location}.${unknown}`,
    );
  }
}

function parseSchemaVersion(record: UnknownRecord, ctx: DiagnosticContext): void {
  const version = required(record, "schema_version", ctx, "schema_version");
  if (version !== 1) {
    fail(
      ctx,
      "SCHEMA_UNSUPPORTED_VERSION",
      "Only integer schema_version = 1 is supported.",
      "schema_version",
    );
  }
}

function parseEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  ctx: DiagnosticContext,
  location: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(ctx, "SCHEMA_INVALID_ENUM", `Expected one of: ${values.join(", ")}.`, location);
  }
  return value as T;
}

function parsePresentation(
  record: UnknownRecord,
  ctx: DiagnosticContext,
  location: string,
): Presentation {
  const fill = parsePaint(record.fill, record.fill_fallback, ctx, `${location}.fill`);
  const stroke = parsePaint(record.stroke, record.stroke_fallback, ctx, `${location}.stroke`);
  const strokeWidth =
    record.stroke_width === undefined
      ? undefined
      : parseFiniteNumber(record.stroke_width, ctx, `${location}.stroke_width`);
  if (strokeWidth !== undefined && strokeWidth < 0) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "stroke_width must be non-negative.", `${location}.stroke_width`);
  }
  const strokeMiterlimit =
    record.stroke_miterlimit === undefined
      ? undefined
      : parseFiniteNumber(record.stroke_miterlimit, ctx, `${location}.stroke_miterlimit`);
  if (strokeMiterlimit !== undefined && strokeMiterlimit < 1) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "stroke_miterlimit must be at least 1.", `${location}.stroke_miterlimit`);
  }
  const opacity =
    record.opacity === undefined
      ? undefined
      : parseFiniteNumber(record.opacity, ctx, `${location}.opacity`);
  if (opacity !== undefined && (opacity < 0 || opacity > 1)) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "opacity must be in [0, 1].", `${location}.opacity`);
  }
  let ariaHidden: boolean | undefined;
  if (record.aria_hidden !== undefined) {
    if (typeof record.aria_hidden !== "boolean") {
      fail(ctx, "SCHEMA_INVALID_TYPE", "aria_hidden must be a boolean.", `${location}.aria_hidden`);
    }
    ariaHidden = record.aria_hidden;
  }
  return {
    ...(fill === undefined ? {} : { fill }),
    ...(stroke === undefined ? {} : { stroke }),
    ...(strokeWidth === undefined ? {} : { strokeWidth }),
    ...(record.stroke_linecap === undefined
      ? {}
      : {
          strokeLinecap: parseEnum(
            record.stroke_linecap,
            ["butt", "round", "square"],
            ctx,
            `${location}.stroke_linecap`,
          ),
        }),
    ...(record.stroke_linejoin === undefined
      ? {}
      : {
          strokeLinejoin: parseEnum(
            record.stroke_linejoin,
            ["miter", "round", "bevel"],
            ctx,
            `${location}.stroke_linejoin`,
          ),
        }),
    ...(strokeMiterlimit === undefined ? {} : { strokeMiterlimit }),
    ...(opacity === undefined ? {} : { opacity }),
    ...(ariaHidden === undefined ? {} : { ariaHidden }),
  };
}

function parsePath(recordValue: unknown, ctx: DiagnosticContext, location: string): PathSpec {
  const record = asRecord(recordValue, ctx, location);
  expectKeys(record, ["id", "d", "transform", ...PRESENTATION_KEYS], ctx, location);
  const transform = parseTransform(record.transform, ctx, `${location}.transform`);
  return {
    ...parsePresentation(record, ctx, location),
    ...(record.id === undefined ? {} : { id: parseLocalId(record.id, ctx, `${location}.id`) }),
    d: parsePathData(required(record, "d", ctx, `${location}.d`), ctx, `${location}.d`),
    ...(transform === undefined ? {} : { transform }),
  };
}

function parseUse(recordValue: unknown, ctx: DiagnosticContext, location: string): UseSpec {
  const record = asRecord(recordValue, ctx, location);
  expectKeys(record, ["id", "href", "x", "y", "transform", ...PRESENTATION_KEYS], ctx, location);
  const href = asString(required(record, "href", ctx, `${location}.href`), ctx, `${location}.href`);
  if (!href.startsWith("#")) {
    fail(ctx, "SCHEMA_INVALID_REFERENCE", "href must be a local #id reference.", `${location}.href`);
  }
  const x = record.x === undefined ? undefined : parseFiniteNumber(record.x, ctx, `${location}.x`);
  const y = record.y === undefined ? undefined : parseFiniteNumber(record.y, ctx, `${location}.y`);
  const transform = parseTransform(record.transform, ctx, `${location}.transform`);
  return {
    ...parsePresentation(record, ctx, location),
    ...(record.id === undefined ? {} : { id: parseLocalId(record.id, ctx, `${location}.id`) }),
    href: parseLocalId(href.slice(1), ctx, `${location}.href`),
    ...(x === undefined || x === 0 ? {} : { x }),
    ...(y === undefined || y === 0 ? {} : { y }),
    ...(transform === undefined ? {} : { transform }),
  };
}

function parseDefinitionGroup(
  value: unknown,
  ctx: DiagnosticContext,
  location: string,
): DefinitionGroup {
  const record = asRecord(value, ctx, location);
  expectKeys(record, ["id", "paths", ...PRESENTATION_KEYS], ctx, location);
  const paths = asArray(required(record, "paths", ctx, `${location}.paths`), ctx, `${location}.paths`);
  if (paths.length === 0) {
    fail(ctx, "SCHEMA_INVALID_UNION", "Definition groups require at least one path.", `${location}.paths`);
  }
  return {
    ...parsePresentation(record, ctx, location),
    id: parseLocalId(required(record, "id", ctx, `${location}.id`), ctx, `${location}.id`),
    paths: paths.map((path, index) => parsePath(path, ctx, `${location}.paths[${index}]`)),
  };
}

function parseGradientStop(value: unknown, ctx: DiagnosticContext, location: string): GradientStop {
  const record = asRecord(value, ctx, location);
  expectKeys(record, ["offset", "color", "opacity"], ctx, location);
  const offset = parseFiniteNumber(required(record, "offset", ctx, `${location}.offset`), ctx, `${location}.offset`);
  if (offset < 0 || offset > 1) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "Gradient offset must be in [0, 1].", `${location}.offset`);
  }
  const opacity =
    record.opacity === undefined
      ? undefined
      : parseFiniteNumber(record.opacity, ctx, `${location}.opacity`);
  if (opacity !== undefined && (opacity < 0 || opacity > 1)) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "Gradient opacity must be in [0, 1].", `${location}.opacity`);
  }
  return {
    offset,
    color: parseHexColor(required(record, "color", ctx, `${location}.color`), ctx, `${location}.color`),
    ...(opacity === undefined || opacity === 1 ? {} : { opacity }),
  };
}

function parseLinearGradient(value: unknown, ctx: DiagnosticContext, location: string): LinearGradient {
  const record = asRecord(value, ctx, location);
  expectKeys(record, ["id", "x1", "y1", "x2", "y2", "units", "stops"], ctx, location);
  const stops = asArray(required(record, "stops", ctx, `${location}.stops`), ctx, `${location}.stops`);
  if (stops.length < 2) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "A linear gradient requires at least two stops.", `${location}.stops`);
  }
  const units =
    record.units === undefined
      ? undefined
      : parseEnum(record.units, ["userSpaceOnUse", "objectBoundingBox"], ctx, `${location}.units`);
  return {
    id: parseLocalId(required(record, "id", ctx, `${location}.id`), ctx, `${location}.id`),
    x1: parseFiniteNumber(required(record, "x1", ctx, `${location}.x1`), ctx, `${location}.x1`),
    y1: parseFiniteNumber(required(record, "y1", ctx, `${location}.y1`), ctx, `${location}.y1`),
    x2: parseFiniteNumber(required(record, "x2", ctx, `${location}.x2`), ctx, `${location}.x2`),
    y2: parseFiniteNumber(required(record, "y2", ctx, `${location}.y2`), ctx, `${location}.y2`),
    ...(units === "userSpaceOnUse" ? { units } : {}),
    stops: stops.map((stop, index) => parseGradientStop(stop, ctx, `${location}.stops[${index}]`)),
  };
}

function parseDefinitions(
  value: unknown,
  ctx: DiagnosticContext,
): Definitions {
  if (value === undefined) {
    return { linearGradients: [], groups: [], paths: [] };
  }
  const record = asRecord(value, ctx, "definitions");
  expectKeys(record, ["linear_gradients", "groups", "paths"], ctx, "definitions");
  const gradients = record.linear_gradients === undefined ? [] : asArray(record.linear_gradients, ctx, "definitions.linear_gradients");
  const groups = record.groups === undefined ? [] : asArray(record.groups, ctx, "definitions.groups");
  const paths = record.paths === undefined ? [] : asArray(record.paths, ctx, "definitions.paths");
  return {
    linearGradients: gradients.map((gradient, index) =>
      parseLinearGradient(gradient, ctx, `definitions.linear_gradients[${index}]`),
    ),
    groups: groups.map((group, index) =>
      parseDefinitionGroup(group, ctx, `definitions.groups[${index}]`),
    ),
    paths: paths.map((path, index): DefinitionPath => {
      const location = `definitions.paths[${index}]`;
      const parsed = parsePath(path, ctx, location);
      if (parsed.id === undefined) {
        fail(ctx, "SCHEMA_MISSING_KEY", "Definition paths require an id.", `${location}.id`);
      }
      return { ...parsed, id: parsed.id };
    }),
  };
}

function parseElement(value: unknown, ctx: DiagnosticContext, index: number): ArtworkElement {
  const location = `elements[${index}]`;
  const record = asRecord(value, ctx, location);
  const type = required(record, "type", ctx, `${location}.type`);
  if (type === "path") {
    expectKeys(record, ["type", "id", "d", "transform", ...PRESENTATION_KEYS], ctx, location);
    const { type: ignored, ...pathRecord } = record;
    void ignored;
    return { type: "path", ...parsePath(pathRecord, ctx, location) };
  }
  if (type === "use") {
    expectKeys(record, ["type", "id", "href", "x", "y", "transform", ...PRESENTATION_KEYS], ctx, location);
    const { type: ignored, ...useRecord } = record;
    void ignored;
    return { type: "use", ...parseUse(useRecord, ctx, location) };
  }
  if (type !== "group") {
    fail(ctx, "SCHEMA_INVALID_UNION", "Element type must be path, use, or group.", `${location}.type`);
  }
  expectKeys(record, ["type", "id", "paths", "uses", "transform", ...PRESENTATION_KEYS], ctx, location);
  const hasPaths = record.paths !== undefined;
  const hasUses = record.uses !== undefined;
  if (hasPaths === hasUses) {
    fail(ctx, "SCHEMA_INVALID_UNION", "A group must contain exactly one of paths or uses.", location);
  }
  const transform = parseTransform(record.transform, ctx, `${location}.transform`);
  if (hasPaths) {
    const values = asArray(record.paths, ctx, `${location}.paths`);
    if (values.length === 0) {
      fail(ctx, "SCHEMA_INVALID_UNION", "A group body cannot be empty.", `${location}.paths`);
    }
    return {
      type: "group",
      ...parsePresentation(record, ctx, location),
      ...(record.id === undefined ? {} : { id: parseLocalId(record.id, ctx, `${location}.id`) }),
      ...(transform === undefined ? {} : { transform }),
      body: {
        type: "paths",
        paths: values.map((path, pathIndex) => parsePath(path, ctx, `${location}.paths[${pathIndex}]`)),
      },
    };
  }
  const values = asArray(record.uses, ctx, `${location}.uses`);
  if (values.length === 0) {
    fail(ctx, "SCHEMA_INVALID_UNION", "A group body cannot be empty.", `${location}.uses`);
  }
  return {
    type: "group",
    ...parsePresentation(record, ctx, location),
    ...(record.id === undefined ? {} : { id: parseLocalId(record.id, ctx, `${location}.id`) }),
    ...(transform === undefined ? {} : { transform }),
    body: {
      type: "uses",
      uses: values.map((use, useIndex) => parseUse(use, ctx, `${location}.uses[${useIndex}]`)),
    },
  };
}

function parseViewBox(value: unknown, ctx: DiagnosticContext): readonly [number, number, number, number] {
  const text = asString(value, ctx, "canvas.view_box");
  const parts = text.trim().split(/[\t\n\r ]+/);
  if (parts.length !== 4) {
    fail(ctx, "SCHEMA_INVALID_VIEW_BOX", "view_box must contain four finite numbers.", "canvas.view_box");
  }
  const numbers = parts.map((part) => parseNumberText(part, ctx, "canvas.view_box"));
  const [x = 0, y = 0, width = 0, height = 0] = numbers;
  if (width <= 0 || height <= 0) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "view_box width and height must be positive.", "canvas.view_box");
  }
  return [x, y, width, height];
}

function decodeAsset(root: UnknownRecord, ctx: DiagnosticContext): NormalizedAsset {
  parseSchemaVersion(root, ctx);
  expectKeys(root, ["schema_version", "id", "filename", "metadata_text", "canvas", "accessibility", "definitions", "elements"], ctx, "");

  const canvasRecord = asRecord(required(root, "canvas", ctx, "canvas"), ctx, "canvas");
  expectKeys(canvasRecord, ["width", "height", "view_box", "shape_rendering"], ctx, "canvas");
  const width =
    canvasRecord.width === undefined
      ? undefined
      : parseFiniteNumber(canvasRecord.width, ctx, "canvas.width");
  if (width !== undefined && width <= 0) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "Canvas width must be positive.", "canvas.width");
  }
  const height =
    canvasRecord.height === undefined
      ? undefined
      : parseFiniteNumber(canvasRecord.height, ctx, "canvas.height");
  if (height !== undefined && height <= 0) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "Canvas height must be positive.", "canvas.height");
  }
  const shapeRendering =
    canvasRecord.shape_rendering === undefined
      ? undefined
      : parseEnum(
          canvasRecord.shape_rendering,
          ["auto", "optimizeSpeed", "crispEdges", "geometricPrecision"],
          ctx,
          "canvas.shape_rendering",
        );

  const accessibility = asRecord(
    required(root, "accessibility", ctx, "accessibility"),
    ctx,
    "accessibility",
  );
  expectKeys(accessibility, ["title", "title_id", "description", "description_id", "focusable"], ctx, "accessibility");
  const title = normalizeText(asString(required(accessibility, "title", ctx, "accessibility.title"), ctx, "accessibility.title"));
  const description = normalizeText(
    asString(required(accessibility, "description", ctx, "accessibility.description"), ctx, "accessibility.description"),
  );
  if (title === "" || description === "") {
    fail(ctx, "SCHEMA_INVALID_TEXT", "Accessibility text cannot normalize to empty.", "accessibility");
  }
  let focusable: boolean | undefined;
  if (accessibility.focusable !== undefined) {
    if (typeof accessibility.focusable !== "boolean") {
      fail(ctx, "SCHEMA_INVALID_TYPE", "focusable must be a boolean.", "accessibility.focusable");
    }
    focusable = accessibility.focusable;
  }

  const elementValues = asArray(required(root, "elements", ctx, "elements"), ctx, "elements");
  if (elementValues.length === 0) {
    fail(ctx, "SCHEMA_INVALID_RANGE", "An asset requires at least one artwork element.", "elements");
  }
  const svg: SvgDocument = {
    canvas: {
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      viewBox: parseViewBox(required(canvasRecord, "view_box", ctx, "canvas.view_box"), ctx),
      ...(shapeRendering === undefined || shapeRendering === "auto"
        ? {}
        : { shapeRendering: shapeRendering as ShapeRendering }),
    },
    accessibility: {
      title,
      titleId: parseLocalId(required(accessibility, "title_id", ctx, "accessibility.title_id"), ctx, "accessibility.title_id"),
      description,
      descriptionId: parseLocalId(
        required(accessibility, "description_id", ctx, "accessibility.description_id"),
        ctx,
        "accessibility.description_id",
      ),
      ...(focusable === undefined ? {} : { focusable }),
    },
    ...(root.metadata_text === undefined
      ? {}
      : {
          metadataText: normalizeText(
            asString(root.metadata_text, ctx, "metadata_text", true),
          ),
        }),
    definitions: parseDefinitions(root.definitions, ctx),
    elements: elementValues.map((element, index) => parseElement(element, ctx, index)),
  };
  validateSvgDocument(svg, ctx);
  return {
    schemaVersion: 1,
    id: parseAssetId(required(root, "id", ctx, "id"), ctx, "id"),
    filename: parseSvgFilename(required(root, "filename", ctx, "filename"), ctx, "filename"),
    svg,
  };
}

export function parseProjectToml(text: string, source?: string): Result<NormalizedProject> {
  const ctx = context("project-toml", source);
  try {
    const root = asRecord(parseToml(text.replace(/^\uFEFF/, "")), ctx, "");
    parseSchemaVersion(root, ctx);
    expectKeys(root, ["schema_version", "name", "build", "install", "companion"], ctx, "");
    const build = asRecord(required(root, "build", ctx, "build"), ctx, "build");
    expectKeys(build, ["directory"], ctx, "build");
    const installValues = root.install === undefined ? [] : asArray(root.install, ctx, "install");
    const seenAssets = new Set<string>();
    const seenDestinations = new Set<string>();
    const installs = installValues.map((value, index) => {
      const location = `install[${index}]`;
      const record = asRecord(value, ctx, location);
      expectKeys(record, ["asset", "destinations"], ctx, location);
      const asset = parseAssetId(required(record, "asset", ctx, `${location}.asset`), ctx, `${location}.asset`);
      if (seenAssets.has(asset)) {
        fail(ctx, "SCHEMA_DUPLICATE_INSTALL", `Asset '${asset}' has more than one install declaration.`, `${location}.asset`);
      }
      seenAssets.add(asset);
      const destinations = asArray(
        required(record, "destinations", ctx, `${location}.destinations`),
        ctx,
        `${location}.destinations`,
      );
      if (destinations.length === 0) {
        fail(ctx, "SCHEMA_INVALID_RANGE", "An install declaration requires at least one destination.", `${location}.destinations`);
      }
      const parsedDestinations = destinations.map((destination, destinationIndex) => {
        const destinationLocation = `${location}.destinations[${destinationIndex}]`;
        const parsed = parseProjectRelativePath(destination, ctx, destinationLocation);
        if (seenDestinations.has(parsed)) {
          fail(ctx, "SCHEMA_DUPLICATE_DESTINATION", `Install destination '${parsed}' is duplicated.`, destinationLocation);
        }
        seenDestinations.add(parsed);
        return parsed;
      });
      return { asset, destinations: parsedDestinations };
    });
    const companionValues = root.companion === undefined ? [] : asArray(root.companion, ctx, "companion");
    const seenCompanionFiles = new Set<string>();
    const companions = companionValues.map((value, index) => {
      const location = `companion[${index}]`;
      const record = asRecord(value, ctx, location);
      expectKeys(record, ["file", "destinations"], ctx, location);
      const file = parseProjectRelativePath(required(record, "file", ctx, `${location}.file`), ctx, `${location}.file`);
      if (seenCompanionFiles.has(file)) {
        fail(ctx, "SCHEMA_DUPLICATE_COMPANION", `Companion '${file}' has more than one companion declaration.`, `${location}.file`);
      }
      seenCompanionFiles.add(file);
      const destinations = asArray(
        required(record, "destinations", ctx, `${location}.destinations`),
        ctx,
        `${location}.destinations`,
      );
      if (destinations.length === 0) {
        fail(ctx, "SCHEMA_INVALID_RANGE", "A companion declaration requires at least one destination.", `${location}.destinations`);
      }
      const parsedDestinations = destinations.map((destination, destinationIndex) => {
        const destinationLocation = `${location}.destinations[${destinationIndex}]`;
        const parsed = parseProjectRelativePath(destination, ctx, destinationLocation);
        if (seenDestinations.has(parsed)) {
          fail(ctx, "SCHEMA_DUPLICATE_DESTINATION", `Install destination '${parsed}' is duplicated.`, destinationLocation);
        }
        seenDestinations.add(parsed);
        return parsed;
      });
      return { file, destinations: parsedDestinations };
    });
    const name = asString(required(root, "name", ctx, "name"), ctx, "name");
    if (name.trim() === "") {
      fail(ctx, "SCHEMA_INVALID_TEXT", "Project name cannot be blank.", "name");
    }
    return ok({
      schemaVersion: 1,
      name,
      buildDirectory: parseProjectRelativePath(
        required(build, "directory", ctx, "build.directory"),
        ctx,
        "build.directory",
      ),
      installs,
      companions,
    });
  } catch (error) {
    return fromCaught(
      error,
      ctx,
      "TOML_SYNTAX",
      "Invalid TOML syntax.",
      (caught) => caught instanceof TomlError,
    );
  }
}

export function parseAssetToml(text: string, source?: string): Result<NormalizedAsset> {
  const ctx = context("asset-toml", source);
  try {
    return ok(decodeAsset(asRecord(parseToml(text.replace(/^\uFEFF/, "")), ctx, ""), ctx));
  } catch (error) {
    return fromCaught(
      error,
      ctx,
      "TOML_SYNTAX",
      "Invalid TOML syntax.",
      (caught) => caught instanceof TomlError,
    );
  }
}
