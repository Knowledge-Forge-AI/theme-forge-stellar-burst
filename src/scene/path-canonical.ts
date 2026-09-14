import { formatCanonicalNumber } from "./canonical.js";
import { SCENE_LIMITS } from "./constants.js";

// Input has already passed the existing SVG parser. This is an operand spelling
// pass, not a second accepting path grammar. Arc flags are single digits even
// when the source omits whitespace between flags and the following coordinate.
export function canonicalPathData(validated: string): string {
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const number = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
  let position = 0, argument = 0, command = "";
  const output: string[] = [];
  let bytes = 0;
  while (position < validated.length) {
    const char = validated[position]!;
    if (/[\s,]/.test(char)) { position++; continue; }
    let token: string;
    if (/[AaCcHhLlMmQqSsTtVvZz]/.test(char)) {
      command = char.toUpperCase(); argument = 0; token = char; position++;
    } else if (command === "A" && (argument === 3 || argument === 4)) {
      token = char; position++; argument = (argument + 1) % 7;
    } else {
      number.lastIndex = position;
      const match = number.exec(validated);
      if (match === null || !arity[command]) throw new TypeError("Unvalidated scene path.");
      token = formatCanonicalNumber(Number(match[0])); position = number.lastIndex;
      argument = (argument + 1) % arity[command]!;
    }
    bytes += token.length + (output.length === 0 ? 0 : 1);
    if (bytes > SCENE_LIMITS.maxCanonicalPathBytes) throw new RangeError("Canonical path exceeds the 1 MiB output ceiling.");
    output.push(token);
  }
  return output.join(" ");
}
