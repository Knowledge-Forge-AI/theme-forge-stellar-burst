import { fail, type DiagnosticContext } from "../diagnostics.js";
import { formatCanonicalNumber } from "./canonical.js";
import { computeLabelMetrics } from "./glyphs/labels.js";
import {
  composeTransforms,
  transformPoint,
  type Matrix2D,
} from "./transforms.js";
import type {
  ArrowheadType,
  CardinalAnchor,
  ConnectorElement,
  ConnectorEndpoint,
  DiagramNodeElement,
  ElementBounds,
  PathElement,
  SceneElement,
  SymbolDef,
} from "./types.js";

export type { ElementBounds };

/**
 * Union two bounding boxes: [minX, minY, width, height]
 */
export function unionBounds(
  b1: ElementBounds,
  b2: ElementBounds,
): ElementBounds {
  const minX = Math.min(b1[0], b2[0]);
  const minY = Math.min(b1[1], b2[1]);
  const maxX = Math.max(b1[0] + b1[2], b2[0] + b2[2]);
  const maxY = Math.max(b1[1] + b1[3], b2[1] + b2[3]);
  return [minX, minY, Math.max(0, maxX - minX), Math.max(0, maxY - minY)];
}

/**
 * Compute the bounding box [minX, minY, width, height] of an element.
 * If symbols map is provided, `<use>` elements can resolve symbol viewBox.
 * If bounds cannot be computed and element has no explicit bounds, returns undefined.
 */
export function computeElementBounds(
  element: SceneElement,
  symbolsById?: ReadonlyMap<string, SymbolDef>,
): ElementBounds | undefined {
  if (element.bounds !== undefined) {
    return applyTransformToBounds(element.bounds, element.transform);
  }

  let rawBounds: ElementBounds | undefined;

  switch (element.type) {
    case "rect": {
      rawBounds = [element.x, element.y, element.width, element.height];
      break;
    }
    case "circle": {
      rawBounds = [
        element.cx - element.r,
        element.cy - element.r,
        element.r * 2,
        element.r * 2,
      ];
      break;
    }
    case "ellipse": {
      rawBounds = [
        element.cx - element.rx,
        element.cy - element.ry,
        element.rx * 2,
        element.ry * 2,
      ];
      break;
    }
    case "line": {
      const minX = Math.min(element.x1, element.x2);
      const minY = Math.min(element.y1, element.y2);
      const w = Math.abs(element.x2 - element.x1);
      const h = Math.abs(element.y2 - element.y1);
      rawBounds = [minX, minY, w, h];
      break;
    }
    case "polyline":
    case "polygon": {
      if (element.points.length === 0) return undefined;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [px, py] of element.points) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
      rawBounds = [minX, minY, Math.max(0, maxX - minX), Math.max(0, maxY - minY)];
      break;
    }
    case "diagramNode": {
      rawBounds = [element.x, element.y, element.width, element.height];
      break;
    }
    case "group": {
      if (element.children.length === 0) return undefined;
      let acc: ElementBounds | undefined;
      for (const child of element.children) {
        const childBounds = computeElementBounds(child, symbolsById);
        if (childBounds === undefined) {
          return undefined; // missing bounds in child
        }
        acc = acc === undefined ? childBounds : unionBounds(acc, childBounds);
      }
      rawBounds = acc;
      break;
    }
    case "use": {
      const href = element.href.startsWith("#") ? element.href.slice(1) : element.href;
      const symbol = symbolsById?.get(href);
      const w = element.width ?? symbol?.viewBox[2];
      const h = element.height ?? symbol?.viewBox[3];
      if (w !== undefined && h !== undefined && symbol !== undefined) {
        let union: ElementBounds | undefined;
        for (const child of symbol.elements) {
          const b = computeElementBounds(child, symbolsById);
          if (b === undefined) return undefined;
          union = union === undefined ? b : unionBounds(union, b);
        }
        if (union === undefined) return undefined;
        const [vx, vy, vw, vh] = symbol.viewBox;
        const scale = Math.min(w / vw, h / vh);
        const x = element.x ?? 0, y = element.y ?? 0;
        const left = x + (w - vw * scale) / 2 + (union[0] - vx) * scale;
        const top = y + (h - vh * scale) / 2 + (union[1] - vy) * scale;
        const minX = Math.max(x, left), minY = Math.max(y, top);
        rawBounds = [minX, minY, Math.max(0, Math.min(x + w, left + union[2] * scale) - minX), Math.max(0, Math.min(y + h, top + union[3] * scale) - minY)];
      }
      break;
    }
    case "connector": {
      if (!("x" in element.from) || !("x" in element.to)) return undefined;
      rawBounds = undefined;
      break;
    }
    case "label": {
      rawBounds = computeLabelMetrics(element.text, element.scale, element.lineSpacing, element.x, element.y, element.align).bounds;
      break;
    }
    case "path": {
      // Path without explicit bounds cannot be statically bounded without full curve evaluation
      rawBounds = undefined;
      break;
    }
  }

  if (rawBounds === undefined) return undefined;
  if (!rawBounds.every(Number.isFinite)) throw new RangeError("Non-finite scene bounds.");
  return applyTransformToBounds(rawBounds, element.transform);
}

function applyTransformToBounds(
  bounds: ElementBounds,
  transforms: readonly import("./types.js").TransformOperation[] | undefined,
): ElementBounds {
  if (transforms === undefined || transforms.length === 0) {
    return bounds;
  }
  const mat = composeTransforms(transforms);
  const [bx, by, bw, bh] = bounds;
  const corners: readonly (readonly [number, number])[] = [
    [bx, by],
    [bx + bw, by],
    [bx, by + bh],
    [bx + bw, by + bh],
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const corner of corners) {
    const [tx, ty] = transformPoint(mat, corner);
    if (tx < minX) minX = tx;
    if (ty < minY) minY = ty;
    if (tx > maxX) maxX = tx;
    if (ty > maxY) maxY = ty;
  }

  return [minX, minY, Math.max(0, maxX - minX), Math.max(0, maxY - minY)];
}

/**
 * Get the cardinal anchor coordinate for a given bounding box.
 */
export function getCardinalAnchor(
  bounds: ElementBounds,
  anchor: CardinalAnchor,
): readonly [number, number] {
  const [x, y, w, h] = bounds;
  switch (anchor) {
    case "top":
      return [x + w / 2, y];
    case "bottom":
      return [x + w / 2, y + h];
    case "left":
      return [x, y + h / 2];
    case "right":
      return [x + w, y + h / 2];
    case "center":
      return [x + w / 2, y + h / 2];
  }
}

/**
 * Resolve a connector endpoint to an absolute coordinate [x, y].
 */
export function resolveEndpoint(
  endpoint: ConnectorEndpoint,
  boundsById: ReadonlyMap<string, ElementBounds>,
  ctx?: DiagnosticContext,
  location?: string,
): readonly [number, number] {
  if ("x" in endpoint && "y" in endpoint) {
    return [endpoint.x, endpoint.y];
  }
  const bounds = boundsById.get(endpoint.elementId);
  if (bounds === undefined) {
    if (ctx !== undefined && location !== undefined) {
      fail(
        ctx,
        "SCENE_MISSING_ANCHOR_TARGET",
        `Connector endpoint references unknown element or anchor target '${endpoint.elementId}'.`,
        location,
      );
    }
    throw new Error(`Connector endpoint references unknown element '${endpoint.elementId}'.`);
  }
  return getCardinalAnchor(bounds, endpoint.anchor);
}

/**
 * Resolve all route points for a connector (start, intermediate waypoints, end).
 */
export function resolveConnectorPoints(
  connector: ConnectorElement,
  boundsById: ReadonlyMap<string, ElementBounds>,
  ctx?: DiagnosticContext,
  location?: string,
): readonly (readonly [number, number])[] {
  const start = resolveEndpoint(connector.from, boundsById, ctx, `${location}.from`);
  const end = resolveEndpoint(connector.to, boundsById, ctx, `${location}.to`);

  if (connector.routing === "straight") {
    if (connector.waypoints !== undefined && connector.waypoints.length > 0) {
      return [start, ...connector.waypoints, end];
    }
    return [start, end];
  }

  // Orthogonal routing
  if (connector.waypoints !== undefined && connector.waypoints.length > 0) {
    return [start, ...connector.waypoints, end];
  }

  return [start, end];
}

export interface ArrowheadGeometry {
  readonly pathD: string;
  readonly basePoint: readonly [number, number];
  readonly isFilled: boolean;
}

/**
 * Compute arrowhead geometric path at a tip point, directed along vector (dx, dy).
 * Closed triangle lowers to a filled polygon; open chevron lowers to an open stroke path.
 */
export function computeArrowhead(
  tip: readonly [number, number],
  directionVector: readonly [number, number],
  type: ArrowheadType,
  size = 8,
): ArrowheadGeometry | undefined {
  if (type === "none") return undefined;

  const [tx, ty] = tip;
  const [dx, dy] = directionVector;
  const magnitude = Math.max(Math.abs(dx), Math.abs(dy));
  if (magnitude === 0) return undefined;
  if (!Number.isFinite(magnitude)) throw new RangeError("Arrow direction must be finite.");
  const sx = dx / magnitude, sy = dy / magnitude;
  const squared = sx * sx + sy * sy;
  // Fixed binary64 Newton recurrence on [1,2], avoiding host sqrt/hypot and
  // the overflow/underflow of squaring unscaled authored coordinates.
  let root = 1;
  for (let n = 0; n < 8; n++) root = (root + squared / root) / 2;
  const ux = sx / root;
  const uy = sy / root;
  const px = -uy;
  const py = ux;

  const wingWidth = size * 0.55;
  const bx = tx - ux * size;
  const by = ty - uy * size;

  const lx = bx + px * wingWidth;
  const ly = by + py * wingWidth;
  const rx = bx - px * wingWidth;
  const ry = by - py * wingWidth;

  const fTipX = formatCanonicalNumber(tx);
  const fTipY = formatCanonicalNumber(ty);
  const fLx = formatCanonicalNumber(lx);
  const fLy = formatCanonicalNumber(ly);
  const fRx = formatCanonicalNumber(rx);
  const fRy = formatCanonicalNumber(ry);

  if (type === "triangle") {
    return {
      pathD: `M ${fTipX} ${fTipY} L ${fLx} ${fLy} L ${fRx} ${fRy} Z`,
      basePoint: [bx, by],
      isFilled: true,
    };
  } else if (type === "chevron") {
    return {
      pathD: `M ${fLx} ${fLy} L ${fTipX} ${fTipY} L ${fRx} ${fRy}`,
      basePoint: [bx, by],
      isFilled: false,
    };
  }

  return undefined;
}

/**
 * Lower a connector into pure SVG paths (the main connector route line plus arrowheads).
 */
export function lowerConnectorToElements(
  connector: ConnectorElement,
  boundsById: ReadonlyMap<string, ElementBounds>,
  ctx?: DiagnosticContext,
  location?: string,
): readonly PathElement[] {
  const rawPoints = resolveConnectorPoints(connector, boundsById, ctx, location);
  const reject = (message: string): never => {
    if (ctx !== undefined) fail(ctx, "SCENE_INVALID_CONNECTOR", message, location);
    throw new RangeError(message);
  };
  if (connector.routing === "straight" && (connector.waypoints?.length ?? 0) > 0) reject("Straight connectors cannot have waypoints.");
  for (let i = 1; i < rawPoints.length; i++) {
    const a = rawPoints[i - 1]!, b = rawPoints[i]!;
    if (![...a, ...b].every(Number.isFinite)) reject("Connector coordinates must remain finite.");
    if (a[0] === b[0] && a[1] === b[1]) reject("Connector segments must have positive length.");
    if (connector.routing === "orthogonal" && a[0] !== b[0] && a[1] !== b[1]) reject("Orthogonal connectors require explicit axis-aligned waypoints.");
  }
  if (rawPoints.length < 2) {
    return [];
  }

  const points = [...rawPoints.map((p) => [p[0], p[1]] as [number, number])];
  const results: PathElement[] = [];
  const arrowSize = connector.arrowheadSize ?? 8;
  const strokeColor = connector.presentation?.stroke ?? { type: "currentColor" };

  // Lower end arrowhead
  if (connector.endArrowhead && connector.endArrowhead !== "none") {
    const lastIdx = points.length - 1;
    const pEnd = points[lastIdx]!;
    const pPrev = points[lastIdx - 1]!;
    const dir: [number, number] = [pEnd[0] - pPrev[0], pEnd[1] - pPrev[1]];
    const arrow = computeArrowhead(pEnd, dir, connector.endArrowhead, arrowSize);
    if (arrow !== undefined) {
      points[lastIdx] = [arrow.basePoint[0], arrow.basePoint[1]];
      results.push({
        type: "path",
        d: arrow.pathD,
        presentation: {
          fill: arrow.isFilled ? strokeColor : { type: "none" },
          stroke: arrow.isFilled ? { type: "none" } : strokeColor,
          strokeWidth: connector.presentation?.strokeWidth ?? 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
      });
    }
  }

  // Lower start arrowhead
  if (connector.startArrowhead && connector.startArrowhead !== "none") {
    const pStart = points[0]!;
    const pNext = points[1]!;
    const dir: [number, number] = [pStart[0] - pNext[0], pStart[1] - pNext[1]];
    const arrow = computeArrowhead(pStart, dir, connector.startArrowhead, arrowSize);
    if (arrow !== undefined) {
      points[0] = [arrow.basePoint[0], arrow.basePoint[1]];
      results.push({
        type: "path",
        d: arrow.pathD,
        presentation: {
          fill: arrow.isFilled ? strokeColor : { type: "none" },
          stroke: arrow.isFilled ? { type: "none" } : strokeColor,
          strokeWidth: connector.presentation?.strokeWidth ?? 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
      });
    }
  }

  // Route path
  const dParts: string[] = [`M ${formatCanonicalNumber(points[0]![0])} ${formatCanonicalNumber(points[0]![1])}`];
  for (let i = 1; i < points.length; i += 1) {
    dParts.push(`L ${formatCanonicalNumber(points[i]![0])} ${formatCanonicalNumber(points[i]![1])}`);
  }

  const linePath: PathElement = {
    type: "path",
    ...(connector.id !== undefined ? { id: connector.id } : {}),
    d: dParts.join(" "),
    presentation: {
      fill: { type: "none" },
      stroke: strokeColor,
      strokeWidth: connector.presentation?.strokeWidth ?? 1.5,
      strokeLinecap: connector.presentation?.strokeLinecap ?? "round",
      strokeLinejoin: connector.presentation?.strokeLinejoin ?? "round",
      ...(connector.presentation ?? {}),
    },
    ...(connector.transform !== undefined ? { transform: connector.transform } : {}),
  };

  return [linePath, ...results];
}
