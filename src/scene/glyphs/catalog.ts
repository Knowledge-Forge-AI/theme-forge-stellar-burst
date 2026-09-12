import { computeSha256, type Sha256Digest } from "../../digests.js";

/**
 * Forge Grid Label v1 — First-Party Geometric Glyph Catalog
 *
 * Authorship:
 *   Original geometric vector construction authored specifically for Theme Forge Stellar Burst.
 *   Design method: Pure discrete integer 5x7 active cell on a fixed 6x10 advance grid.
 *   All strokes are composed of orthogonal (horizontal/vertical) lines, 45-degree diagonals,
 *   or bounded integer coordinate segments.
 *   NO external fonts, NO font tracing, NO OpenType/TrueType extraction, NO third-party corpora.
 *
 * License:
 *   AGPL-3.0-or-later; separately available commercial terms apply.
 *
 * Coverage:
 *   Full printable ASCII range U+0020 through U+007E (95 glyphs total).
 *   Fixed cell advance: 6 units.
 *   Fixed line height: 10 units.
 *   Fixed stroke width baseline: 1 unit.
 */

export interface GlyphMetric {
  readonly char: string;
  readonly code: number;
  readonly d: string;
  readonly advance: number;
  readonly height: number;
}

export const FORGE_GRID_CELL_WIDTH = 6 as const;
export const FORGE_GRID_CELL_HEIGHT = 10 as const;
export const FORGE_GRID_BASELINE = 6 as const;

const RAW_GLYPH_TABLE: Readonly<Record<number, string>> = {
  32: "", // Space
  33: "M 2 0 L 2 4 M 2 6 L 2 7", // !
  34: "M 1 0 L 1 2 M 3 0 L 3 2", // "
  35: "M 1 0 L 1 6 M 3 0 L 3 6 M 0 2 L 4 2 M 0 4 L 4 4", // #
  36: "M 2 0 L 2 7 M 4 1 L 1 1 L 1 3 L 4 3 L 4 5 L 0 5", // $
  37: "M 0 0 L 1 0 L 1 1 L 0 1 Z M 3 5 L 4 5 L 4 6 L 3 6 Z M 4 0 L 0 6", // %
  38: "M 4 6 L 2 4 L 3 2 L 2 0 L 1 0 L 0 2 L 2 4 L 0 6 L 3 6", // &
  39: "M 2 0 L 2 2", // '
  40: "M 3 0 L 1 2 L 1 4 L 3 6", // (
  41: "M 1 0 L 3 2 L 3 4 L 1 6", // )
  42: "M 2 1 L 2 5 M 0 3 L 4 3 M 1 2 L 3 4 M 1 4 L 3 2", // *
  43: "M 2 1 L 2 5 M 0 3 L 4 3", // +
  44: "M 2 5 L 2 6 L 1 7", // ,
  45: "M 1 3 L 4 3", // -
  46: "M 2 5 L 2 6", // .
  47: "M 0 6 L 4 0", // /
  48: "M 0 0 L 4 0 L 4 6 L 0 6 Z M 4 0 L 0 6", // 0
  49: "M 1 1 L 2 0 L 2 6 M 1 6 L 3 6", // 1
  50: "M 0 1 L 1 0 L 3 0 L 4 1 L 4 3 L 0 6 L 4 6", // 2
  51: "M 0 0 L 4 0 L 2 3 L 4 4 L 4 5 L 3 6 L 0 6", // 3
  52: "M 3 6 L 3 0 L 0 3 L 4 3", // 4
  53: "M 4 0 L 0 0 L 0 3 L 3 3 L 4 4 L 4 5 L 3 6 L 0 6", // 5
  54: "M 3 0 L 1 0 L 0 2 L 0 5 L 1 6 L 3 6 L 4 5 L 4 3 L 0 3", // 6
  55: "M 0 0 L 4 0 L 2 6", // 7
  56: "M 1 0 L 3 0 L 4 1 L 4 2 L 3 3 L 4 4 L 4 5 L 3 6 L 1 6 L 0 5 L 0 4 L 1 3 L 0 2 L 0 1 Z M 1 3 L 3 3", // 8
  57: "M 4 3 L 0 3 L 0 1 L 1 0 L 3 0 L 4 2 L 4 5 L 3 6 L 1 6", // 9
  58: "M 2 2 L 2 3 M 2 5 L 2 6", // :
  59: "M 2 2 L 2 3 M 2 5 L 2 6 L 1 7", // ;
  60: "M 3 1 L 1 3 L 3 5", // <
  61: "M 0 2 L 4 2 M 0 4 L 4 4", // =
  62: "M 1 1 L 3 3 L 1 5", // >
  63: "M 0 1 L 1 0 L 3 0 L 4 1 L 4 2 L 2 4 M 2 6 L 2 7", // ?
  64: "M 4 4 L 4 1 L 3 0 L 1 0 L 0 1 L 0 5 L 1 6 L 3 6 L 4 5 L 4 3 L 2 3 L 2 4 L 3 4", // @
  65: "M 0 6 L 0 2 L 2 0 L 4 2 L 4 6 M 0 4 L 4 4", // A
  66: "M 0 0 L 3 0 L 4 1 L 4 2 L 3 3 L 4 4 L 4 5 L 3 6 L 0 6 Z M 0 3 L 3 3", // B
  67: "M 4 1 L 3 0 L 1 0 L 0 1 L 0 5 L 1 6 L 3 6 L 4 5", // C
  68: "M 0 0 L 3 0 L 4 2 L 4 4 L 3 6 L 0 6 Z", // D
  69: "M 4 0 L 0 0 L 0 6 L 4 6 M 0 3 L 3 3", // E
  70: "M 4 0 L 0 0 L 0 6 M 0 3 L 3 3", // F
  71: "M 4 1 L 3 0 L 1 0 L 0 1 L 0 5 L 1 6 L 3 6 L 4 5 L 4 3 L 2 3", // G
  72: "M 0 0 L 0 6 M 4 0 L 4 6 M 0 3 L 4 3", // H
  73: "M 1 0 L 3 0 M 2 0 L 2 6 M 1 6 L 3 6", // I
  74: "M 3 0 L 3 5 L 2 6 L 1 6 L 0 5", // J
  75: "M 0 0 L 0 6 M 4 0 L 0 3 L 4 6", // K
  76: "M 0 0 L 0 6 L 4 6", // L
  77: "M 0 6 L 0 0 L 2 3 L 4 0 L 4 6", // M
  78: "M 0 6 L 0 0 L 4 6 L 4 0", // N
  79: "M 1 0 L 3 0 L 4 1 L 4 5 L 3 6 L 1 6 L 0 5 L 0 1 Z", // O
  80: "M 0 6 L 0 0 L 3 0 L 4 1 L 4 3 L 3 4 L 0 4", // P
  81: "M 1 0 L 3 0 L 4 1 L 4 5 L 3 6 L 1 6 L 0 5 L 0 1 Z M 2 4 L 4 6", // Q
  82: "M 0 6 L 0 0 L 3 0 L 4 1 L 4 3 L 3 4 L 0 4 M 2 4 L 4 6", // R
  83: "M 4 1 L 3 0 L 1 0 L 0 1 L 0 2 L 1 3 L 3 3 L 4 4 L 4 5 L 3 6 L 1 6 L 0 5", // S
  84: "M 0 0 L 4 0 M 2 0 L 2 6", // T
  85: "M 0 0 L 0 5 L 1 6 L 3 6 L 4 5 L 4 0", // U
  86: "M 0 0 L 2 6 L 4 0", // V
  87: "M 0 0 L 0 6 L 2 3 L 4 6 L 4 0", // W
  88: "M 0 0 L 4 6 M 4 0 L 0 6", // X
  89: "M 0 0 L 2 3 L 4 0 M 2 3 L 2 6", // Y
  90: "M 0 0 L 4 0 L 0 6 L 4 6", // Z
  91: "M 3 0 L 1 0 L 1 6 L 3 6", // [
  92: "M 0 0 L 4 6", // \
  93: "M 1 0 L 3 0 L 3 6 L 1 6", // ]
  94: "M 1 2 L 2 0 L 3 2", // ^
  95: "M 0 7 L 4 7", // _
  96: "M 1 0 L 2 1", // `
  97: "M 4 3 L 1 3 L 0 4 L 0 5 L 1 6 L 3 6 L 4 5 L 4 2 L 3 2 L 1 2 L 0 3 M 4 4 L 4 6", // a
  98: "M 0 0 L 0 6 M 0 3 L 3 2 L 4 3 L 4 5 L 3 6 L 0 6", // b
  99: "M 4 3 L 3 2 L 1 2 L 0 3 L 0 5 L 1 6 L 3 6 L 4 5", // c
  100: "M 4 0 L 4 6 M 4 6 L 1 6 L 0 5 L 0 3 L 1 2 L 4 3", // d
  101: "M 4 5 L 3 6 L 1 6 L 0 5 L 0 3 L 1 2 L 3 2 L 4 3 L 4 4 L 0 4", // e
  102: "M 3 0 L 2 0 L 1 1 L 1 6 M 0 3 L 3 3", // f
  103: "M 4 2 L 1 2 L 0 3 L 0 5 L 1 6 L 4 6 L 4 8 L 3 9 L 1 9", // g
  104: "M 0 0 L 0 6 M 0 3 L 1 2 L 3 2 L 4 3 L 4 6", // h
  105: "M 2 1 L 2 2 M 2 3 L 2 6", // i
  106: "M 3 1 L 3 2 M 3 3 L 3 8 L 2 9 L 1 9", // j
  107: "M 0 0 L 0 6 M 4 2 L 1 4 L 4 6 M 1 4 L 0 4", // k
  108: "M 1 0 L 2 0 L 2 6 L 3 6", // l
  109: "M 0 2 L 0 6 M 0 3 L 1 2 L 2 3 L 2 6 M 2 3 L 3 2 L 4 3 L 4 6", // m
  110: "M 0 2 L 0 6 M 0 3 L 1 2 L 3 2 L 4 3 L 4 6", // n
  111: "M 1 2 L 3 2 L 4 3 L 4 5 L 3 6 L 1 6 L 0 5 L 0 3 Z", // o
  112: "M 0 2 L 0 8 M 0 3 L 1 2 L 3 2 L 4 3 L 4 5 L 3 6 L 0 6", // p
  113: "M 4 2 L 4 8 M 4 3 L 3 2 L 1 2 L 0 3 L 0 5 L 1 6 L 4 6", // q
  114: "M 0 2 L 0 6 M 0 3 L 1 2 L 3 2 L 4 3", // r
  115: "M 4 3 L 3 2 L 1 2 L 0 3 L 1 4 L 3 4 L 4 5 L 3 6 L 1 6 L 0 5", // s
  116: "M 1 1 L 1 5 L 2 6 L 3 6 M 0 2 L 3 2", // t
  117: "M 0 2 L 0 5 L 1 6 L 3 6 L 4 5 L 4 2 M 4 5 L 4 6", // u
  118: "M 0 2 L 2 6 L 4 2", // v
  119: "M 0 2 L 0 6 L 2 4 L 4 6 L 4 2", // w
  120: "M 0 2 L 4 6 M 4 2 L 0 6", // x
  121: "M 0 2 L 2 6 L 4 2 M 2 6 L 1 8 L 0 8", // y
  122: "M 0 2 L 4 2 L 0 6 L 4 6", // z
  123: "M 3 0 L 2 0 L 2 2 L 1 3 L 2 4 L 2 6 L 3 6", // {
  124: "M 2 0 L 2 6", // |
  125: "M 1 0 L 2 0 L 2 2 L 3 3 L 2 4 L 2 6 L 1 6", // }
  126: "M 0 3 L 1 2 L 2 3 L 3 2 L 4 3", // ~
};

export const FORGE_GRID_CATALOG: readonly GlyphMetric[] = Object.freeze(
  Array.from({ length: 95 }, (_, i) => {
    const code = 32 + i;
    const char = String.fromCharCode(code);
    const d = RAW_GLYPH_TABLE[code];
    if (d === undefined) {
      throw new Error(`Missing glyph in table: ${code} '${char}'`);
    }
    return Object.freeze({
      char,
      code,
      d,
      advance: FORGE_GRID_CELL_WIDTH,
      height: FORGE_GRID_CELL_HEIGHT,
    });
  }),
);

export const GLYPH_BY_CODE: ReadonlyMap<number, GlyphMetric> = new Map(
  FORGE_GRID_CATALOG.map((glyph) => [glyph.code, glyph]),
);

export function getGlyph(char: string): GlyphMetric | undefined {
  if (char.length !== 1) return undefined;
  const code = char.charCodeAt(0);
  return GLYPH_BY_CODE.get(code);
}

/**
 * Pinned catalog digest. Computed via computeCatalogDigest().
 * Tests assert that computeCatalogDigest() matches this pinned value exactly.
 */
export const FORGE_GRID_LABEL_V1_DIGEST: Sha256Digest =
  "sha256:8ec3bc8e99cf1cda2cdc362f5a0b6e1f94a8e1c544853d9af46bd999f8a0941a";

export function computeCatalogDigest(): Sha256Digest {
  return computeSha256(JSON.stringify({ schema: "tfsb.forge-grid-label-v1", cellWidth: FORGE_GRID_CELL_WIDTH, cellHeight: FORGE_GRID_CELL_HEIGHT, baseline: FORGE_GRID_BASELINE, strokeWidth: 1, glyphs: FORGE_GRID_CATALOG }));
}
