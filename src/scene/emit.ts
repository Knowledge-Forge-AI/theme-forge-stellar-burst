import { fail, type DiagnosticContext } from "../diagnostics.js";
import { formatCanonicalNumber } from "./canonical.js";
import {
  serializeTransforms,
} from "./transforms.js";
import type {
  GradientDef,
  LinearGradientDef,
  Paint,
  Presentation,
  RadialGradientDef,
  SceneAccessibility,
  SceneElement,
  SymbolDef,
  VectorScene,
} from "./types.js";

const MAX_SVG_BYTES = 33_554_432;

const SVG_NS = "http://www.w3.org/2000/svg";

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function numAttr(name: string, value: number | undefined): string {
  if (value === undefined) return "";
  return ` ${name}="${formatCanonicalNumber(value)}"`;
}

function strAttr(name: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return ` ${name}="${escapeAttr(value)}"`;
}

function resolvePaint(
  paint: Paint | undefined,
  tokenBindings: Readonly<Record<string, string>> | undefined,
  ctx: DiagnosticContext,
  location: string,
): string | undefined {
  if (paint === undefined) return undefined;
  switch (paint.type) {
    case "none":
      return "none";
    case "currentColor":
      return "currentColor";
    case "solid":
      return paint.color;
    case "token": {
      const resolved = tokenBindings?.[paint.name];
      if (resolved === undefined) {
        fail(
          ctx,
          "SCENE_UNRESOLVED_TOKEN",
          `Paint token '${paint.name}' could not be resolved from tokenBindings.`,
          location,
        );
      }
      return resolved;
    }
    case "gradient": {
      return `url(#${paint.id})${paint.fallback !== undefined ? ` ${paint.fallback}` : ""}`;
    }
  }
}

function renderPresentation(
  p: Presentation | undefined,
  tokenBindings: Readonly<Record<string, string>> | undefined,
  ctx: DiagnosticContext,
  location: string,
): string {
  if (p === undefined) return "";
  let out = "";

  const fill = resolvePaint(p.fill, tokenBindings, ctx, `${location}.fill`);
  if (fill !== undefined) out += strAttr("fill", fill);
  if (p.fillRule !== undefined) out += strAttr("fill-rule", p.fillRule);
  if (p.clipRule !== undefined) out += strAttr("clip-rule", p.clipRule);
  if (p.fillOpacity !== undefined) out += numAttr("fill-opacity", p.fillOpacity);

  const stroke = resolvePaint(p.stroke, tokenBindings, ctx, `${location}.stroke`);
  if (stroke !== undefined) out += strAttr("stroke", stroke);
  if (p.strokeWidth !== undefined) out += numAttr("stroke-width", p.strokeWidth);
  if (p.strokeLinecap !== undefined) out += strAttr("stroke-linecap", p.strokeLinecap);
  if (p.strokeLinejoin !== undefined) out += strAttr("stroke-linejoin", p.strokeLinejoin);
  if (p.strokeMiterlimit !== undefined) out += numAttr("stroke-miterlimit", p.strokeMiterlimit);

  if (p.strokeDasharray !== undefined && p.strokeDasharray.length > 0) {
    const da = p.strokeDasharray.map(formatCanonicalNumber).join(" ");
    out += strAttr("stroke-dasharray", da);
  }
  if (p.strokeDashoffset !== undefined) out += numAttr("stroke-dashoffset", p.strokeDashoffset);
  if (p.strokeOpacity !== undefined) out += numAttr("stroke-opacity", p.strokeOpacity);

  if (p.opacity !== undefined) out += numAttr("opacity", p.opacity);
  if (p.ariaHidden !== undefined) out += strAttr("aria-hidden", p.ariaHidden ? "true" : "false");

  return out;
}

function renderElement(
  element: SceneElement,
  tokenBindings: Readonly<Record<string, string>> | undefined,
  ctx: DiagnosticContext,
  depth: number,
  location: string,
  pushLine: (line: string) => void,
): void {
  const indent = "  ".repeat(depth);
  const idAttr = strAttr("id", element.id);
  const presAttr = renderPresentation(element.presentation, tokenBindings, ctx, location);
  const transStr = serializeTransforms(element.transform);
  const transAttr = transStr !== undefined ? strAttr("transform", transStr) : "";
  const ariaLabel = (element as { readonly ariaLabel?: string }).ariaLabel;
  const ariaLabelAttr = ariaLabel !== undefined && ariaLabel !== "" ? strAttr("aria-label", ariaLabel) : "";

  switch (element.type) {
    case "path": {
      pushLine(`${indent}<path${idAttr} d="${escapeAttr(element.d)}"${presAttr}${ariaLabelAttr}${transAttr}/>`);
      return;
    }
    case "rect": {
      const rxAttr = numAttr("rx", element.rx);
      const ryAttr = numAttr("ry", element.ry);
      pushLine(
        `${indent}<rect${idAttr}${numAttr("x", element.x)}${numAttr("y", element.y)}${numAttr("width", element.width)}${numAttr("height", element.height)}${rxAttr}${ryAttr}${presAttr}${ariaLabelAttr}${transAttr}/>`,
      );
      return;
    }
    case "circle": {
      pushLine(
        `${indent}<circle${idAttr}${numAttr("cx", element.cx)}${numAttr("cy", element.cy)}${numAttr("r", element.r)}${presAttr}${ariaLabelAttr}${transAttr}/>`,
      );
      return;
    }
    case "ellipse": {
      pushLine(
        `${indent}<ellipse${idAttr}${numAttr("cx", element.cx)}${numAttr("cy", element.cy)}${numAttr("rx", element.rx)}${numAttr("ry", element.ry)}${presAttr}${ariaLabelAttr}${transAttr}/>`,
      );
      return;
    }
    case "line": {
      pushLine(
        `${indent}<line${idAttr}${numAttr("x1", element.x1)}${numAttr("y1", element.y1)}${numAttr("x2", element.x2)}${numAttr("y2", element.y2)}${presAttr}${ariaLabelAttr}${transAttr}/>`,
      );
      return;
    }
    case "polyline":
    case "polygon": {
      const pointsStr = element.points
        .map(([px, py]) => `${formatCanonicalNumber(px)},${formatCanonicalNumber(py)}`)
        .join(" ");
      pushLine(
        `${indent}<${element.type}${idAttr} points="${escapeAttr(pointsStr)}"${presAttr}${ariaLabelAttr}${transAttr}/>`,
      );
      return;
    }
    case "use": {
      pushLine(
        `${indent}<use${idAttr} href="${escapeAttr(element.href)}"${numAttr("x", element.x)}${numAttr("y", element.y)}${numAttr("width", element.width)}${numAttr("height", element.height)}${presAttr}${ariaLabelAttr}${transAttr}/>`,
      );
      return;
    }
    case "group": {
      pushLine(`${indent}<g${idAttr}${presAttr}${ariaLabelAttr}${transAttr}>`);
      for (let idx = 0; idx < element.children.length; idx += 1) {
        renderElement(element.children[idx]!, tokenBindings, ctx, depth + 1, `${location}.children[${idx}]`, pushLine);
      }
      pushLine(`${indent}</g>`);
      return;
    }
    case "diagramNode":
    case "connector":
    case "label": {
      // These elements must be lowered to basic geometry before emission!
      throw new Error(`Element type '${element.type}' must be lowered before emission.`);
    }
  }
}

function renderLinearGradient(
  g: LinearGradientDef,
  tokenBindings: Readonly<Record<string, string>> | undefined,
  ctx: DiagnosticContext,
  depth: number,
  location: string,
  pushLine: (line: string) => void,
): void {
  const indent = "  ".repeat(depth);
  const unitsAttr = strAttr("gradientUnits", g.gradientUnits ?? "objectBoundingBox");
  const spreadAttr = strAttr("spreadMethod", g.spreadMethod ?? "pad");
  pushLine(`${indent}<linearGradient id="${escapeAttr(g.id)}"${numAttr("x1", g.x1)}${numAttr("y1", g.y1)}${numAttr("x2", g.x2)}${numAttr("y2", g.y2)}${unitsAttr}${spreadAttr}>`);

  for (let sIdx = 0; sIdx < g.stops.length; sIdx += 1) {
    const stop = g.stops[sIdx]!;
    const stopColor = resolvePaint(stop.color, tokenBindings, ctx, `${location}.stops[${sIdx}].color`);
    pushLine(`${indent}  <stop offset="${formatCanonicalNumber(stop.offset)}"${strAttr("stop-color", stopColor)}${numAttr("stop-opacity", stop.opacity)}/>`);
  }

  pushLine(`${indent}</linearGradient>`);
}

function renderRadialGradient(
  g: RadialGradientDef,
  tokenBindings: Readonly<Record<string, string>> | undefined,
  ctx: DiagnosticContext,
  depth: number,
  location: string,
  pushLine: (line: string) => void,
): void {
  const indent = "  ".repeat(depth);
  const unitsAttr = strAttr("gradientUnits", g.gradientUnits ?? "objectBoundingBox");
  const spreadAttr = strAttr("spreadMethod", g.spreadMethod ?? "pad");
  const fxAttr = numAttr("fx", g.fx);
  const fyAttr = numAttr("fy", g.fy);
  pushLine(`${indent}<radialGradient id="${escapeAttr(g.id)}"${numAttr("cx", g.cx)}${numAttr("cy", g.cy)}${numAttr("r", g.r)}${fxAttr}${fyAttr}${unitsAttr}${spreadAttr}>`);

  for (let sIdx = 0; sIdx < g.stops.length; sIdx += 1) {
    const stop = g.stops[sIdx]!;
    const stopColor = resolvePaint(stop.color, tokenBindings, ctx, `${location}.stops[${sIdx}].color`);
    pushLine(`${indent}  <stop offset="${formatCanonicalNumber(stop.offset)}"${strAttr("stop-color", stopColor)}${numAttr("stop-opacity", stop.opacity)}/>`);
  }

  pushLine(`${indent}</radialGradient>`);
}

function renderSymbol(
  sym: SymbolDef,
  tokenBindings: Readonly<Record<string, string>> | undefined,
  ctx: DiagnosticContext,
  depth: number,
  location: string,
  pushLine: (line: string) => void,
): void {
  const indent = "  ".repeat(depth);
  const vbStr = sym.viewBox.map(formatCanonicalNumber).join(" ");
  pushLine(`${indent}<symbol id="${escapeAttr(sym.id)}" viewBox="${escapeAttr(vbStr)}" preserveAspectRatio="xMidYMid meet" overflow="hidden">`);
  for (let idx = 0; idx < sym.elements.length; idx += 1) {
    renderElement(sym.elements[idx]!, tokenBindings, ctx, depth + 1, `${location}.elements[${idx}]`, pushLine);
  }
  pushLine(`${indent}</symbol>`);
}

/**
 * Emit canonical, deterministic SVG string for a lowered VectorScene.
 */
export function emitSvg(scene: VectorScene, ctx: DiagnosticContext): string {
  const lines: string[] = [];
  let currentBytes = 0;

  const pushLine = (line: string): void => {
    const lineBytes = Buffer.byteLength(line, "utf8");
    const newlineBytes = lines.length > 0 ? 1 : 0;
    if (currentBytes + newlineBytes + lineBytes > MAX_SVG_BYTES) {
      fail(ctx, "SCENE_OUTPUT_LIMIT", "Scene SVG exceeds 32 MiB.");
    }
    currentBytes += newlineBytes + lineBytes;
    lines.push(line);
  };

  pushLine('<?xml version="1.0" encoding="UTF-8"?>');

  const widthAttr = numAttr("width", scene.artboard.width);
  const heightAttr = numAttr("height", scene.artboard.height);
  const vbStr = scene.artboard.viewBox.map(formatCanonicalNumber).join(" ");
  const vbAttr = strAttr("viewBox", vbStr);

  const ids = new Set<string>();
  const collect = (items: readonly SceneElement[]): void => {
    for (const item of items) {
      if (item.id) ids.add(item.id);
      if (item.type === "group") collect(item.children);
    }
  };
  collect(scene.elements);
  for (const symbol of scene.definitions?.symbols ?? []) {
    ids.add(symbol.id);
    collect(symbol.elements);
  }
  for (const gradient of scene.definitions?.gradients ?? []) ids.add(gradient.id);
  const allocate = (base: string): string => {
    let id = base, n = 0;
    while (ids.has(id)) id = `${base}-${++n}`;
    ids.add(id);
    return id;
  };

  const titleId = allocate("scene-title");
  const hasDesc = scene.accessibility.mode === "labelled" && scene.accessibility.desc !== undefined && scene.accessibility.desc !== "";
  const descId = hasDesc ? allocate("scene-desc") : undefined;

  let a11yAttrs = "";
  if (scene.accessibility.mode === "labelled") {
    a11yAttrs += ' role="img"';
    if (descId !== undefined) {
      a11yAttrs += ` aria-labelledby="${titleId} ${descId}"`;
    } else {
      a11yAttrs += ` aria-labelledby="${titleId}"`;
    }
  } else {
    a11yAttrs += ' aria-hidden="true" role="presentation"';
  }

  if (scene.accessibility.mode === "decorative") {
    a11yAttrs += ' focusable="false"';
  } else if (scene.accessibility.focusable !== undefined) {
    a11yAttrs += strAttr("focusable", scene.accessibility.focusable ? "true" : "false");
  }

  pushLine(`<svg xmlns="${SVG_NS}"${widthAttr}${heightAttr}${vbAttr} preserveAspectRatio="${scene.artboard.policy === "pad" ? "xMinYMin" : "xMidYMid"} meet"${a11yAttrs}>`);

  // Accessibility elements
  if (scene.accessibility.mode === "labelled") {
    pushLine(`  <title id="${titleId}">${escapeText(scene.accessibility.title)}</title>`);
    if (descId !== undefined) {
      pushLine(`  <desc id="${descId}">${escapeText(scene.accessibility.desc!)}</desc>`);
    }
  }

  const gradients = [...(scene.definitions?.gradients ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const symbols = [...(scene.definitions?.symbols ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // Defs
  const hasGradients =
    scene.definitions?.gradients !== undefined && scene.definitions.gradients.length > 0;
  const hasSymbols =
    scene.definitions?.symbols !== undefined && scene.definitions.symbols.length > 0;

  if (hasGradients || hasSymbols) {
    pushLine("  <defs>");

    if (scene.definitions?.gradients !== undefined) {
      for (let i = 0; i < scene.definitions.gradients.length; i += 1) {
        const g = gradients[i]!;
        if (g.type === "linearGradient") {
          renderLinearGradient(g, scene.tokenBindings, ctx, 2, `definitions.gradients[${i}]`, pushLine);
        } else {
          renderRadialGradient(g, scene.tokenBindings, ctx, 2, `definitions.gradients[${i}]`, pushLine);
        }
      }
    }

    if (scene.definitions?.symbols !== undefined) {
      for (let i = 0; i < scene.definitions.symbols.length; i += 1) {
        const s = symbols[i]!;
        renderSymbol(s, scene.tokenBindings, ctx, 2, `definitions.symbols[${i}]`, pushLine);
      }
    }

    pushLine("  </defs>");
  }

  // Artwork elements in authored order
  for (let i = 0; i < scene.elements.length; i += 1) {
    renderElement(scene.elements[i]!, scene.tokenBindings, ctx, 1, `elements[${i}]`, pushLine);
  }

  pushLine("</svg>\n");
  return lines.join("\n");
}
