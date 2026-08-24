import { fail, type DiagnosticContext } from "./diagnostics.js";
import type {
  AssetId,
  HexColor,
  LocalId,
  Paint,
  PathData,
  ProjectRelativePath,
  SvgFilename,
  TransformOperation,
} from "./types.js";

const NUMBER_SOURCE = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER_PATTERN = new RegExp(`^${NUMBER_SOURCE}$`);
export const LOCAL_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ASSET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SVG_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.svg$/;
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const PATH_COMMAND_PATTERN = /^[AaCcHhLlMmQqSsTtVvZz]$/;

function inputCode(
  context: DiagnosticContext,
  schemaCode: string,
  xmlCode: string,
): string {
  return context.domain === "svg" ? xmlCode : schemaCode;
}

export function normalizeText(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  const nonblank = lines.filter((line) => line.trim() !== "");
  const commonIndent =
    nonblank.length === 0
      ? 0
      : Math.min(
          ...nonblank.map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0),
        );
  return lines
    .map((line) => (line.trim() === "" ? "" : line.slice(commonIndent)))
    .join("\n");
}

export function parseFiniteNumber(
  value: unknown,
  context: DiagnosticContext,
  location: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(context, "SCHEMA_INVALID_NUMBER", "Expected a finite number.", location);
  }
  return Object.is(value, -0) ? 0 : value;
}

export function parseNumberText(
  value: string,
  context: DiagnosticContext,
  location: string,
): number {
  if (!NUMBER_PATTERN.test(value)) {
    fail(
      context,
      inputCode(context, "SCHEMA_INVALID_NUMBER", "XML_INVALID_NUMBER"),
      "Expected a finite decimal number.",
      location,
    );
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    fail(
      context,
      inputCode(context, "SCHEMA_INVALID_NUMBER", "XML_INVALID_NUMBER"),
      "Expected a finite decimal number.",
      location,
    );
  }
  return Object.is(number, -0) ? 0 : number;
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("Cannot serialize a non-finite number.");
  }
  if (Object.is(value, -0)) return "0";
  const source = String(value);
  if (!/[eE]/.test(source)) return source;

  const sign = source.startsWith("-") ? "-" : "";
  const unsigned = source.replace(/^[+-]/, "");
  const [coefficient = "", exponentText = "0"] = unsigned.split(/[eE]/);
  const exponent = Number(exponentText);
  const [integer = "", fraction = ""] = coefficient.split(".");
  const digits = integer + fraction;
  const decimalIndex = integer.length + exponent;

  if (decimalIndex <= 0) {
    return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

export function parseAssetId(
  value: unknown,
  context: DiagnosticContext,
  location: string,
): AssetId {
  if (typeof value !== "string" || !ASSET_ID_PATTERN.test(value)) {
    fail(
      context,
      "SCHEMA_INVALID_ASSET_ID",
      "Expected a lowercase kebab-case asset id.",
      location,
    );
  }
  return value as AssetId;
}

export function parseLocalId(
  value: unknown,
  context: DiagnosticContext,
  location: string,
): LocalId {
  if (typeof value !== "string" || !LOCAL_ID_PATTERN.test(value)) {
    fail(
      context,
      inputCode(context, "SCHEMA_INVALID_ID", "XML_INVALID_ID"),
      "Expected a local XML id.",
      location,
    );
  }
  return value as LocalId;
}

export function isLocalId(value: string): boolean {
  return LOCAL_ID_PATTERN.test(value);
}

export function parseSvgFilename(
  value: unknown,
  context: DiagnosticContext,
  location: string,
): SvgFilename {
  if (typeof value !== "string" || !SVG_FILENAME_PATTERN.test(value)) {
    fail(
      context,
      "SCHEMA_INVALID_FILENAME",
      "Expected a filename ending in .svg with no directory components.",
      location,
    );
  }
  return value as SvgFilename;
}

export function parseProjectRelativePath(
  value: unknown,
  context: DiagnosticContext,
  location: string,
): ProjectRelativePath {
  if (typeof value !== "string" || value.length === 0) {
    fail(context, "SCHEMA_INVALID_PATH", "Expected a non-empty relative path.", location);
  }
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith("//")
  ) {
    fail(context, "SCHEMA_INVALID_PATH", "Path must be project-relative and use / separators.", location);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(context, "SCHEMA_INVALID_PATH", "Path contains an empty, . or .. segment.", location);
  }
  return value as ProjectRelativePath;
}

export function parseHexColor(
  value: unknown,
  context: DiagnosticContext,
  location: string,
): HexColor {
  if (typeof value !== "string" || !HEX_COLOR_PATTERN.test(value)) {
    fail(
      context,
      inputCode(context, "SCHEMA_INVALID_COLOR", "XML_INVALID_COLOR"),
      "Expected a #RRGGBB color.",
      location,
    );
  }
  return value.toUpperCase() as HexColor;
}

export function parsePaint(
  value: unknown,
  fallback: unknown,
  context: DiagnosticContext,
  location: string,
): Paint | undefined {
  const invalidPaintCode = inputCode(
    context,
    "SCHEMA_INVALID_PAINT",
    "XML_INVALID_PAINT",
  );
  const invalidFallbackCode = inputCode(
    context,
    "SCHEMA_INVALID_PAINT_FALLBACK",
    "XML_INVALID_PAINT_FALLBACK",
  );
  if (value === undefined) {
    if (fallback !== undefined) {
      fail(
        context,
        invalidFallbackCode,
        "A paint fallback requires a local gradient paint.",
        `${location}_fallback`,
      );
    }
    return undefined;
  }
  if (typeof value !== "string") {
    fail(context, invalidPaintCode, "Expected a supported paint string.", location);
  }
  if (value === "none") {
    if (fallback !== undefined) {
      fail(context, invalidFallbackCode, "Only gradient paint accepts a fallback.", `${location}_fallback`);
    }
    return { type: "none" };
  }
  if (HEX_COLOR_PATTERN.test(value)) {
    if (fallback !== undefined) {
      fail(context, invalidFallbackCode, "Only gradient paint accepts a fallback.", `${location}_fallback`);
    }
    return { type: "solid", color: value.toUpperCase() as HexColor };
  }
  const match = /^url\(#([^)]+)\)$/.exec(value);
  if (match === null) {
    fail(context, invalidPaintCode, "Paint must be none, #RRGGBB, or url(#local-id).", location);
  }
  const reference = parseLocalId(match[1], context, location);
  return {
    type: "linear-gradient",
    reference,
    ...(fallback === undefined
      ? {}
      : { fallback: parseHexColor(fallback, context, `${location}_fallback`) }),
  };
}

export function parseSvgPaint(
  value: string,
  context: DiagnosticContext,
  location: string,
): Paint {
  const match = /^url\(#([^)]+)\)(?:[\t\n\r ]+(#[0-9A-Fa-f]{6}))?$/.exec(value);
  if (match !== null) {
    return {
      type: "linear-gradient",
      reference: parseLocalId(match[1], context, location),
      ...(match[2] === undefined
        ? {}
        : { fallback: match[2].toUpperCase() as HexColor }),
    };
  }
  if (/^url\(/i.test(value)) {
    fail(
      context,
      "XML_EXTERNAL_REFERENCE",
      "Paint URLs must be asset-local url(#id) references.",
      location,
    );
  }
  const parsed = parsePaint(value, undefined, context, location);
  if (parsed === undefined) {
    fail(context, "XML_INVALID_PAINT", "Expected a supported paint.", location);
  }
  return parsed;
}

export function parsePathData(
  value: unknown,
  context: DiagnosticContext,
  location: string,
): PathData {
  const invalidPathCode = inputCode(
    context,
    "SCHEMA_INVALID_PATH_DATA",
    "XML_INVALID_PATH_DATA",
  );
  if (typeof value !== "string") {
    fail(context, invalidPathCode, "Expected SVG path data.", location);
  }
  const normalized = value.replace(/[\t\n\r ]+/g, " ").trim();
  if (!/^[Mm]/.test(normalized)) {
    fail(context, invalidPathCode, "Path data must begin with moveto.", location);
  }

  const arity: Readonly<Record<string, number>> = {
    A: 7,
    C: 6,
    H: 1,
    L: 2,
    M: 2,
    Q: 4,
    S: 4,
    T: 2,
    V: 1,
    Z: 0,
  };
  const numberAtStart = new RegExp(`^${NUMBER_SOURCE}`);
  let position = 0;
  let command: string | undefined;

  const skipWhitespace = (): boolean => {
    const match = /^[\t\n\r ]+/.exec(normalized.slice(position));
    if (match === null) return false;
    position += match[0].length;
    return true;
  };

  const consumeSeparator = (firstArgument: boolean): void => {
    skipWhitespace();
    if (normalized[position] !== ",") return;
    if (firstArgument) {
      fail(context, invalidPathCode, "Path data contains a misplaced comma.", location);
    }
    position += 1;
    skipWhitespace();
    if (normalized[position] === "," || position >= normalized.length) {
      fail(context, invalidPathCode, "Path data contains a misplaced comma.", location);
    }
  };

  while (position < normalized.length) {
    skipWhitespace();
    const possibleCommand = normalized[position];
    if (possibleCommand !== undefined && PATH_COMMAND_PATTERN.test(possibleCommand)) {
      command = possibleCommand.toUpperCase();
      position += 1;
    } else if (command === undefined) {
      fail(context, invalidPathCode, "Expected an SVG path command.", location);
    }

    const expected = command === undefined ? undefined : arity[command];
    if (expected === undefined) {
      fail(context, invalidPathCode, "Unsupported SVG path command.", location);
    }
    if (expected === 0) {
      command = undefined;
      continue;
    }

    let setCount = 0;
    while (position < normalized.length) {
      skipWhitespace();
      const next = normalized[position];
      if (next !== undefined && PATH_COMMAND_PATTERN.test(next)) break;

      const values: number[] = [];
      for (let argument = 0; argument < expected; argument += 1) {
        consumeSeparator(setCount === 0 && argument === 0);
        const rest = normalized.slice(position);
        if (command === "A" && (argument === 3 || argument === 4)) {
          const flag = rest[0];
          if (flag !== "0" && flag !== "1") {
            fail(context, invalidPathCode, "Arc flags must be 0 or 1.", location);
          }
          values.push(Number(flag));
          position += 1;
          continue;
        }
        const number = numberAtStart.exec(rest);
        if (number === null) {
          fail(context, invalidPathCode, "Path command has the wrong number of arguments.", location);
        }
        const parsed = Number(number[0]);
        if (!Number.isFinite(parsed)) {
          fail(context, invalidPathCode, "Path data contains a non-finite number.", location);
        }
        values.push(parsed);
        position += number[0].length;
      }

      if (command === "A" && ((values[0] ?? -1) < 0 || (values[1] ?? -1) < 0)) {
        fail(context, invalidPathCode, "Arc radii must be non-negative.", location);
      }
      setCount += 1;
      skipWhitespace();
      const following = normalized[position];
      if (following !== undefined && PATH_COMMAND_PATTERN.test(following)) break;
      if (position >= normalized.length) break;
      if (following === ",") {
        continue;
      }
      if (numberAtStart.test(normalized.slice(position))) continue;
      fail(context, invalidPathCode, "Path data contains invalid SVG syntax.", location);
    }
    if (setCount === 0) {
      fail(context, invalidPathCode, "Path command has the wrong number of arguments.", location);
    }
  }
  return normalized as PathData;
}

export function parseTransform(
  value: unknown,
  context: DiagnosticContext,
  location: string,
): readonly TransformOperation[] | undefined {
  const invalidTransformCode = inputCode(
    context,
    "SCHEMA_INVALID_TRANSFORM",
    "XML_INVALID_TRANSFORM",
  );
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    fail(context, invalidTransformCode, "Expected translate/scale transform operations.", location);
  }
  const operations: TransformOperation[] = [];
  let rest = value.trim();
  const operationPattern = new RegExp(
    `^(translate|scale)\\(\\s*(${NUMBER_SOURCE})(?:[\\t\\n\\r ]+(${NUMBER_SOURCE}))?\\s*\\)`,
  );
  while (rest.length > 0) {
    const match = operationPattern.exec(rest);
    if (match === null) {
      fail(
        context,
        invalidTransformCode,
        "Only whitespace-separated translate and scale operations are supported.",
        location,
      );
    }
    const x = Number(match[2]);
    const rawY = match[3] === undefined ? undefined : Number(match[3]);
    if (!Number.isFinite(x) || (rawY !== undefined && !Number.isFinite(rawY))) {
      fail(context, invalidTransformCode, "Transform arguments must be finite.", location);
    }
    const type = match[1] as "translate" | "scale";
    const defaultY = type === "translate" ? 0 : x;
    operations.push({
      type,
      x: Object.is(x, -0) ? 0 : x,
      ...(rawY === undefined || rawY === defaultY
        ? {}
        : { y: Object.is(rawY, -0) ? 0 : rawY }),
    });
    rest = rest.slice(match[0].length);
    if (rest.length > 0) {
      const separator = /^[\t\n\r ]+/.exec(rest);
      if (separator === null) {
        fail(context, invalidTransformCode, "Transform operations require whitespace separation.", location);
      }
      rest = rest.slice(separator[0].length);
    }
  }
  return operations;
}

export function serializeTransform(
  operations: readonly TransformOperation[] | undefined,
): string | undefined {
  if (operations === undefined) return undefined;
  return operations
    .map((operation) =>
      `${operation.type}(${formatNumber(operation.x)}${
        operation.y === undefined ? "" : ` ${formatNumber(operation.y)}`
      })`,
    )
    .join(" ");
}

export function serializePaint(paint: Paint): string {
  if (paint.type === "none") return "none";
  if (paint.type === "solid") return paint.color;
  return `url(#${paint.reference})${paint.fallback === undefined ? "" : ` ${paint.fallback}`}`;
}
