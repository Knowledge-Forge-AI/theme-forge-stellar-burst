import { formatCanonicalNumber } from "./canonical.js";
import { SCENE_LIMITS } from "./constants.js";

const PATH_ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const SHORT_CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]{0,5})$/u;

// Input has already passed the existing SVG parser. This is an operand spelling
// pass, not a second accepting path grammar. Arc flags are single digits even
// when the source omits whitespace between flags and the following coordinate.
export function canonicalPathData(validated: string): string {
  const output: string[] = [];
  measureCanonicalPath(validated, output);
  return output.join(" ");
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
    if (/[\s,]/.test(char)) { position++; continue; }
    let token: string;
    if (/[AaCcHhLlMmQqSsTtVvZz]/.test(char)) {
      command = char.toUpperCase(); argument = 0; token = char; position++;
      if (command === "Z") segments++;
    } else if (command === "A" && (argument === 3 || argument === 4)) {
      token = char; position++; argument = (argument + 1) % 7;
    } else {
      number.lastIndex = position;
      const match = number.exec(validated);
      const count = PATH_ARITY[command];
      if (match === null || !count) throw new TypeError("Unvalidated scene path.");
      // Traced contours mostly contain small integers already in canonical form.
      token = SHORT_CANONICAL_INTEGER.test(match[0]) ? match[0] : formatCanonicalNumber(Number(match[0]));
      position = number.lastIndex;
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
  return path.replace(/ *([AaCcHhLlMmQqSsTtVvZz]) */g, "$1");
}
