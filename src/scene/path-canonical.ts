import { formatCanonicalNumber } from "./canonical.js";
import { SCENE_LIMITS } from "./constants.js";
import { shortPathIntegerEnd } from "../path-number.js";
import type { SceneElement, VectorScene } from "./types.js";

const PATH_ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const PATH_COMMANDS = "AaCcHhLlMmQqSsTtVvZz";

// Input has already passed the existing SVG parser. This is an operand spelling
// pass, not a second accepting path grammar. Arc flags are single digits even
// when the source omits whitespace between flags and the following coordinate.
export function canonicalPathData(validated: string): string {
  return canonicalPathWithCount(validated).data;
}

export function canonicalPathWithCount(validated: string): { readonly data: string; readonly segments: number } {
  const output: string[] = [];
  const segments = measureCanonicalPath(validated, output);
  return { data: output.join(" "), segments };
}

export function countCanonicalPathSegments(validated: string): number {
  return measureCanonicalPath(validated);
}

function measureCanonicalPath(validated: string, output?: string[]): number {
  const number = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
  let position = 0, argument = 0, command = "";
  let bytes = 0, segments = 0;
  while (position < validated.length) {
    const char = validated[position]!;
    if (char === " " || char === "," || (char < " " || char > "~") && /\s/.test(char)) {
      position++;
      continue;
    }
    let token: string;
    if (PATH_COMMANDS.includes(char)) {
      command = char.toUpperCase(); argument = 0; token = char; position++;
      if (command === "Z") segments++;
    } else if (command === "A" && (argument === 3 || argument === 4)) {
      token = char; position++; argument = (argument + 1) % 7;
    } else {
      const count = PATH_ARITY[command];
      if (!count) throw new TypeError("Unvalidated scene path.");
      const integerEnd = shortPathIntegerEnd(validated, position);
      if (integerEnd !== 0) {
        token = validated.slice(position, integerEnd);
        position = integerEnd;
      } else {
        number.lastIndex = position;
        const match = number.exec(validated);
        if (match === null) throw new TypeError("Unvalidated scene path.");
        token = formatCanonicalNumber(Number(match[0]));
        position = number.lastIndex;
      }
      argument = (argument + 1) % count;
      if (argument === 0) segments++;
    }
    bytes += token.length + (bytes === 0 ? 0 : 1);
    if (bytes > SCENE_LIMITS.maxCanonicalPathBytes) throw new RangeError("Canonical path exceeds the 1 MiB output ceiling.");
    output?.push(token);
  }
  return bytes === 0 ? 0 : Math.max(1, segments);
}

/** Remove optional spacing from canonical path data. */
export function compactCanonicalPathData(path: string): string {
  return path.replace(/ +([AaCcHhLlMmQqSsTtVvZz]) *|([AaCcHhLlMmQqSsTtVvZz]) +/g, "$1$2");
}

/** Shorten canonical coordinate spelling while retaining operand boundaries. */
export function compactCanonicalPathOperands(path: string): string {
  return path.replace(/(?<![0-9.])(-?)0\.(?=[0-9])/g, "$1.").replace(/ +(?=-[0-9.])/g, "");
}

export function mapScenePaths(scene: VectorScene, formatPath: (data: string) => string): VectorScene {
  let bytes = 0;
  const visit = (items: readonly SceneElement[]): SceneElement[] => items.map((item) => {
    if (item.type === "group") return { ...item, children: visit(item.children) };
    if (item.type !== "path") return item;
    const d = formatPath(item.d);
    bytes += Buffer.byteLength(d);
    if (bytes > SCENE_LIMITS.maxCanonicalPathsBytes) throw new RangeError("Canonical scene paths exceed 16 MiB.");
    return { ...item, d };
  });
  const elements = visit(scene.elements);
  const symbols = scene.definitions?.symbols?.map((symbol) => ({ ...symbol, elements: visit(symbol.elements) }));
  return symbols ? { ...scene, elements, definitions: { ...scene.definitions, symbols } } : { ...scene, elements };
}
