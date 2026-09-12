import { fail, type DiagnosticContext } from "../../diagnostics.js";
import { formatCanonicalNumber } from "../canonical.js";
import { SCENE_LIMITS } from "../constants.js";
import type { ElementBounds, LabelElement, PathElement } from "../types.js";
import {
  FORGE_GRID_CELL_HEIGHT,
  FORGE_GRID_CELL_WIDTH,
  getGlyph,
} from "./catalog.js";

export interface LabelMetrics {
  readonly width: number;
  readonly height: number;
  readonly glyphCount: number;
  readonly lineCount: number;
  readonly bounds: ElementBounds;
}

/**
 * Validate that label text contains only printable ASCII (32..126) and newlines,
 * and does not exceed per-label glyph limit.
 */
export function validateLabelText(
  text: string,
  ctx: DiagnosticContext,
  location: string,
  maxGlyphs: number = SCENE_LIMITS.maxGlyphsPerLabel,
): void {
  if (text.length > SCENE_LIMITS.maxGlyphsPerLabel * 2) {
    fail(ctx, "SCENE_LIMIT_EXCEEDED", "Label character/newline count exceeds the production limit.", location);
  }
  let glyphCount = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // LF is the only canonical newline.
    if (code === 10) {
      continue;
    }
    if (code < 32 || code > 126) {
      fail(
        ctx,
        "SCENE_INVALID_CHARACTER",
        `Forge Grid Label v1 rejects non-printable or non-ASCII character at index ${i} (U+${code.toString(16).toUpperCase().padStart(4, "0")}).`,
        location,
      );
    }
    glyphCount += 1;
  }

  if (glyphCount > maxGlyphs) {
    fail(
      ctx,
      "SCENE_LIMIT_EXCEEDED",
      `Label glyph count ${glyphCount} exceeds maximum allowed per label (${maxGlyphs}).`,
      location,
    );
  }
}

/**
 * Count printable glyphs in a text string (excluding newline characters).
 */
export function countLabelGlyphs(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 32 && code <= 126) {
      count += 1;
    }
  }
  return count;
}

export function computeLabelMetrics(
  text: string,
  scale = 1,
  lineSpacing: number = FORGE_GRID_CELL_HEIGHT,
  x = 0,
  y = 0,
  align: "left" | "center" | "right" = "left",
): LabelMetrics {
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  let maxLineWidth = 0;
  let glyphCount = 0;

  for (const line of rawLines) {
    const lineChars = countLabelGlyphs(line);
    glyphCount += lineChars;
    const lineWidth = line.length * FORGE_GRID_CELL_WIDTH * scale;
    if (lineWidth > maxLineWidth) {
      maxLineWidth = lineWidth;
    }
  }

  const lineCount = rawLines.length;
  const totalHeight =
    lineCount === 0
      ? 0
      : (lineCount * lineSpacing - (lineSpacing - FORGE_GRID_CELL_HEIGHT)) * scale;

  let minX = x;
  if (align === "center") {
    minX = x - maxLineWidth / 2;
  } else if (align === "right") {
    minX = x - maxLineWidth;
  }

  return {
    width: maxLineWidth,
    height: totalHeight,
    glyphCount,
    lineCount,
    bounds: [minX, y, maxLineWidth, totalHeight],
  };
}

/**
 * Transform a glyph's raw path d string to absolute coordinates with scale and offset.
 */
function transformGlyphPath(
  d: string,
  offsetX: number,
  offsetY: number,
  scale: number,
): string {
  if (d === "") return "";
  const tokens = d.trim().split(/\s+/);
  const parts: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const cmd = tokens[i]!;
    if (cmd === "M" || cmd === "L") {
      const gx = Number(tokens[i + 1]);
      const gy = Number(tokens[i + 2]);
      const absX = offsetX + gx * scale;
      const absY = offsetY + gy * scale;
      parts.push(cmd, formatCanonicalNumber(absX), formatCanonicalNumber(absY));
      i += 3;
    } else if (cmd === "Z") {
      parts.push("Z");
      i += 1;
    } else {
      throw new Error(`Unexpected command '${cmd}' in Forge Grid Label catalog`);
    }
  }

  return parts.join(" ");
}

/**
 * Lowers a Forge Grid Label element into a standard path element.
 */
export function lowerLabelToPath(
  label: LabelElement,
  ctx?: DiagnosticContext,
  location?: string,
): PathElement {
  if (ctx !== undefined && location !== undefined) {
    validateLabelText(label.text, ctx, location);
  }

  const scale = label.scale ?? 1;
  const lineSpacing = label.lineSpacing ?? FORGE_GRID_CELL_HEIGHT;
  const align = label.align ?? "left";
  const rawLines = label.text.replace(/\r\n/g, "\n").split("\n");

  const pathSegments: string[] = [];
  let currentY = label.y;

  for (const line of rawLines) {
    const lineWidth = line.length * FORGE_GRID_CELL_WIDTH * scale;
    let lineStartX = label.x;
    if (align === "center") {
      lineStartX = label.x - lineWidth / 2;
    } else if (align === "right") {
      lineStartX = label.x - lineWidth;
    }

    let cursorX = lineStartX;
    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const char = line[charIndex]!;
      const glyph = getGlyph(char);
      if (glyph === undefined) {
        if (ctx !== undefined && location !== undefined) {
          fail(
            ctx,
            "SCENE_INVALID_CHARACTER",
            `Unsupported character '${char}' in Forge Grid Label.`,
            location,
          );
        }
        throw new Error(`Unsupported character '${char}' in Forge Grid Label.`);
      }

      if (glyph.d !== "") {
        const transformed = transformGlyphPath(glyph.d, cursorX, currentY, scale);
        if (transformed !== "") {
          pathSegments.push(transformed);
        }
      }

      cursorX += glyph.advance * scale;
    }

    currentY += lineSpacing * scale;
  }

  const combinedD = pathSegments.join(" ");
  const metrics = computeLabelMetrics(
    label.text,
    scale,
    lineSpacing,
    label.x,
    label.y,
    align,
  );

  return {
    type: "path",
    ...(label.id !== undefined ? { id: label.id } : {}),
    d: combinedD === "" ? "M 0 0" : combinedD,
    presentation: {
      fill: { type: "none" },
      stroke: label.color ?? { type: "currentColor" },
      strokeWidth: scale,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      ...(label.presentation ?? {}),
    },
    ...(label.transform !== undefined ? { transform: label.transform } : {}),
    bounds: metrics.bounds,
  };
}
