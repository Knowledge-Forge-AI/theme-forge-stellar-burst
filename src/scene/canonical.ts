import { computeSha256, type Sha256Digest } from "../digests.js";
import { formatNumber } from "../primitives.js";

/** Finite binary64 shortest-round-trip decimal, exponent-expanded, without rounding. */
export function formatCanonicalNumber(value: number): string {
  return formatNumber(value);
}

function utf8KeyCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Produce deterministic canonical JSON string:
 * - Object keys sorted by UTF-8 bytes
 * - Exact canonical number formatting
 * - No whitespace outside strings
 * - Rejects undefined, NaN, Infinity, Functions, BigInt, Symbols
 * - Circular references throw TypeError
 */
export function canonicalJsonStringify(rootValue: unknown): string {
  const active = new WeakSet<object>();

  function stringify(value: unknown, path: string): string {
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError(`Non-finite number at ${path}: ${value}`);
      }
      return formatCanonicalNumber(value);
    }
    if (typeof value !== "object") {
      throw new TypeError(`Unsupported canonical JSON type '${typeof value}' at ${path}`);
    }

    if (active.has(value)) {
      throw new TypeError(`Circular reference detected in canonical JSON at ${path}`);
    }
    active.add(value);

    try {
      if (Array.isArray(value)) {
        const items = value.map((item, idx) => stringify(item, `${path}[${idx}]`));
        return `[${items.join(",")}]`;
      }

      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`Unsupported custom object class at ${path}`);
      }

      const keys = Object.keys(value).sort(utf8KeyCompare);
      const entries: string[] = [];
      for (const key of keys) {
        const val = (value as Record<string, unknown>)[key];
        if (val === undefined) {
          throw new TypeError(`Undefined property '${key}' at ${path}`);
        }
        entries.push(`${JSON.stringify(key)}:${stringify(val, `${path}.${key}`)}`);
      }
      return `{${entries.join(",")}}`;
    } finally {
      active.delete(value);
    }
  }

  return stringify(rootValue, "$");
}

export function computeCanonicalDigest(value: unknown): Sha256Digest {
  const json = canonicalJsonStringify(value);
  return computeSha256(Buffer.from(json, "utf8"));
}

export function computeTextDigest(text: string): Sha256Digest {
  return computeSha256(Buffer.from(text, "utf8"));
}
