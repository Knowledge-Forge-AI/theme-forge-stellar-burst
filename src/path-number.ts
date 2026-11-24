/** Return the end of a canonical integer of at most six digits, or zero. */
export function shortPathIntegerEnd(path: string, start: number): number {
  const negative = path.charCodeAt(start) === 45;
  const first = negative ? start + 1 : start;
  let code = path.charCodeAt(first);
  if (!(code >= 48 && code <= 57)) return 0;

  let end = first + 1;
  if (code === 48) {
    if (negative) return 0;
    code = path.charCodeAt(end);
  } else {
    code = path.charCodeAt(end);
    while (end - first < 6 && code >= 48 && code <= 57) {
      code = path.charCodeAt(++end);
    }
  }
  // A decimal, an exponent, or more digits belong to the same operand.
  if ((code >= 48 && code <= 57) || code === 46 || code === 69 || code === 101) return 0;
  return end;
}
