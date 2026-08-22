import {
  formatNumber,
  serializePaint,
  serializeTransform,
} from "./primitives.js";
import type {
  ArtworkElement,
  DefinitionGroup,
  NormalizedAsset,
  NormalizedProject,
  PathSpec,
  Presentation,
  UseSpec,
} from "./types.js";

function basicString(value: string): string {
  return JSON.stringify(value)
    .replace(/\u007f/g, "\\u007F")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function multilineString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\u0008/g, "\\b")
    .replace(/\t/g, "\\t")
    .replace(/\f/g, "\\f")
    .replace(/\r/g, "\\r")
    .replace(/[\u0000-\u0007\u000B\u000E-\u001F\u007F]/g, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  return `"""\n${escaped}\n"""`;
}

function readableString(value: string, forceMultiline = false): string {
  return forceMultiline || value.includes("\n") || value.length > 88
    ? multilineString(value)
    : basicString(value);
}

function pathString(value: string): string {
  const commandCount = value.match(/[AaCcHhLlMmQqSsTtVvZz]/g)?.length ?? 0;
  if (value.length <= 96 && commandCount < 3) return basicString(value);
  return multilineString(value.replace(/ +(?=[AaCcHhLlMmQqSsTtVvZz])/g, "\n"));
}

function presentationFields(value: Presentation): readonly string[] {
  const fields: string[] = [];
  if (value.fill !== undefined) {
    const fill =
      value.fill.type === "linear-gradient"
        ? `url(#${value.fill.reference})`
        : serializePaint(value.fill);
    fields.push(`fill = ${basicString(fill)}`);
    if (value.fill.type === "linear-gradient" && value.fill.fallback !== undefined) {
      fields.push(`fill_fallback = ${basicString(value.fill.fallback)}`);
    }
  }
  if (value.stroke !== undefined) {
    const stroke =
      value.stroke.type === "linear-gradient"
        ? `url(#${value.stroke.reference})`
        : serializePaint(value.stroke);
    fields.push(`stroke = ${basicString(stroke)}`);
    if (value.stroke.type === "linear-gradient" && value.stroke.fallback !== undefined) {
      fields.push(`stroke_fallback = ${basicString(value.stroke.fallback)}`);
    }
  }
  if (value.strokeWidth !== undefined) fields.push(`stroke_width = ${formatNumber(value.strokeWidth)}`);
  if (value.strokeLinecap !== undefined) fields.push(`stroke_linecap = ${basicString(value.strokeLinecap)}`);
  if (value.strokeLinejoin !== undefined) fields.push(`stroke_linejoin = ${basicString(value.strokeLinejoin)}`);
  if (value.strokeMiterlimit !== undefined) {
    fields.push(`stroke_miterlimit = ${formatNumber(value.strokeMiterlimit)}`);
  }
  if (value.opacity !== undefined) fields.push(`opacity = ${formatNumber(value.opacity)}`);
  if (value.ariaHidden !== undefined) fields.push(`aria_hidden = ${value.ariaHidden ? "true" : "false"}`);
  return fields;
}

function pathFields(value: PathSpec): readonly string[] {
  return [
    ...(value.id === undefined ? [] : [`id = ${basicString(value.id)}`]),
    ...presentationFields(value),
    ...(value.transform === undefined
      ? []
      : [`transform = ${basicString(serializeTransform(value.transform) ?? "")}`]),
    `d = ${pathString(value.d)}`,
  ];
}

function useFields(value: UseSpec): readonly string[] {
  return [
    ...(value.id === undefined ? [] : [`id = ${basicString(value.id)}`]),
    ...presentationFields(value),
    `href = ${basicString(`#${value.href}`)}`,
    ...(value.x === undefined ? [] : [`x = ${formatNumber(value.x)}`]),
    ...(value.y === undefined ? [] : [`y = ${formatNumber(value.y)}`]),
    ...(value.transform === undefined
      ? []
      : [`transform = ${basicString(serializeTransform(value.transform) ?? "")}`]),
  ];
}

function inlineRecord(fields: readonly string[]): string {
  return `{ ${fields.join(", ")} }`;
}

function compactPath(value: PathSpec): string {
  return inlineRecord(
    pathFields(value).map((field) =>
      field.startsWith("d = ") ? `d = ${basicString(value.d)}` : field,
    ),
  );
}

function compactUse(value: UseSpec): string {
  return inlineRecord(useFields(value));
}

function recordArray(name: "paths" | "uses", records: readonly string[]): readonly string[] {
  return [
    `${name} = [`,
    ...records.map((record) => `  ${record},`),
    "]",
  ];
}

function definitionGroupLines(group: DefinitionGroup): readonly string[] {
  return [
    "[[definitions.groups]]",
    `id = ${basicString(group.id)}`,
    ...presentationFields(group),
    ...recordArray("paths", group.paths.map(compactPath)),
  ];
}

function artworkLines(element: ArtworkElement): readonly string[] {
  if (element.type === "path") {
    return ["[[elements]]", 'type = "path"', ...pathFields(element)];
  }
  if (element.type === "use") {
    return ["[[elements]]", 'type = "use"', ...useFields(element)];
  }
  return [
    "[[elements]]",
    'type = "group"',
    ...(element.id === undefined ? [] : [`id = ${basicString(element.id)}`]),
    ...presentationFields(element),
    ...(element.transform === undefined
      ? []
      : [`transform = ${basicString(serializeTransform(element.transform) ?? "")}`]),
    ...(element.body.type === "paths"
      ? recordArray("paths", element.body.paths.map(compactPath))
      : recordArray("uses", element.body.uses.map(compactUse))),
  ];
}

export function serializeProjectToml(project: NormalizedProject): string {
  const lines = [
    "schema_version = 1",
    `name = ${basicString(project.name)}`,
    "",
    "[build]",
    `directory = ${basicString(project.buildDirectory)}`,
  ];
  for (const install of project.installs) {
    lines.push(
      "",
      "[[install]]",
      `asset = ${basicString(install.asset)}`,
      "destinations = [",
      ...install.destinations.map((destination) => `  ${basicString(destination)},`),
      "]",
    );
  }
  for (const companion of project.companions ?? []) {
    lines.push(
      "",
      "[[companion]]",
      `file = ${basicString(companion.file)}`,
      "destinations = [",
      ...companion.destinations.map((destination) => `  ${basicString(destination)},`),
      "]",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function serializeAssetToml(asset: NormalizedAsset): string {
  const svg = asset.svg;
  const sections: string[][] = [
    [
      "schema_version = 1",
      `id = ${basicString(asset.id)}`,
      `filename = ${basicString(asset.filename)}`,
      ...(svg.metadataText === undefined
        ? []
        : [`metadata_text = ${readableString(svg.metadataText, true)}`]),
    ],
    [
      "[canvas]",
      ...(svg.canvas.width === undefined ? [] : [`width = ${formatNumber(svg.canvas.width)}`]),
      ...(svg.canvas.height === undefined ? [] : [`height = ${formatNumber(svg.canvas.height)}`]),
      `view_box = ${basicString(svg.canvas.viewBox.map(formatNumber).join(" "))}`,
      ...(svg.canvas.shapeRendering === undefined
        ? []
        : [`shape_rendering = ${basicString(svg.canvas.shapeRendering)}`]),
    ],
    [
      "[accessibility]",
      `title = ${readableString(svg.accessibility.title)}`,
      `title_id = ${basicString(svg.accessibility.titleId)}`,
      `description = ${readableString(svg.accessibility.description)}`,
      `description_id = ${basicString(svg.accessibility.descriptionId)}`,
      ...(svg.accessibility.focusable === undefined
        ? []
        : [`focusable = ${svg.accessibility.focusable ? "true" : "false"}`]),
    ],
  ];

  for (const gradient of svg.definitions.linearGradients) {
    sections.push([
      "[[definitions.linear_gradients]]",
      `id = ${basicString(gradient.id)}`,
      `x1 = ${formatNumber(gradient.x1)}`,
      `y1 = ${formatNumber(gradient.y1)}`,
      `x2 = ${formatNumber(gradient.x2)}`,
      `y2 = ${formatNumber(gradient.y2)}`,
      ...(gradient.units === undefined ? [] : [`units = ${basicString(gradient.units)}`]),
      "stops = [",
      ...gradient.stops.map((stop) =>
        `  ${inlineRecord([
          `offset = ${formatNumber(stop.offset)}`,
          `color = ${basicString(stop.color)}`,
          ...(stop.opacity === undefined ? [] : [`opacity = ${formatNumber(stop.opacity)}`]),
        ])},`,
      ),
      "]",
    ]);
  }
  for (const group of svg.definitions.groups) sections.push([...definitionGroupLines(group)]);
  for (const path of svg.definitions.paths) {
    sections.push(["[[definitions.paths]]", ...pathFields(path)]);
  }
  for (const element of svg.elements) sections.push([...artworkLines(element)]);
  return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}
