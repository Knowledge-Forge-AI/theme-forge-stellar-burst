import { createHash } from "node:crypto";

/**
 * The deliberately small value grammar used by the Studio plan digest.
 *
 * This is not intended to model every value accepted by JSON.stringify.  In
 * particular, undefined, non-finite numbers, and objects with a custom
 * prototype are rejected rather than being silently converted or omitted.
 */
export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | number
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export const STUDIO_PLAN_DIGEST_BASIS = "tfsb-studio-plan-v1" as const;
export const STUDIO_PLAN_DIGEST_PREFIX = "sha256:" as const;

export type StudioPlanDigest = `sha256:${string}`;

const PLAN_DIGEST_FIELDS = [
  "authority",
  "handles",
  "method",
  "preState",
  "protocol",
  "protocolVersion",
  "summary",
] as const;

export interface PlanDigestEnvelope {
  readonly authority: CanonicalJsonValue;
  readonly handles: CanonicalJsonValue;
  readonly method: CanonicalJsonValue;
  readonly preState: CanonicalJsonValue;
  readonly protocol: CanonicalJsonValue;
  readonly protocolVersion: CanonicalJsonValue;
  readonly summary: CanonicalJsonValue;
}

function invalid(_path: string): never {
  // Keep the error intentionally free of the rejected path and value. Callers
  // may be canonicalizing an operator choice, path, or token-derived value.
  throw new TypeError("Value is not valid canonical JSON.");
}

function isArrayIndex(key: string, length: number): boolean {
  if (key.length === 0) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function encode(value: unknown, path: string, active: WeakSet<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "string": return JSON.stringify(value);
    case "number": {
      if (!Number.isSafeInteger(value)) invalid(path);
      // JSON.stringify(-0) is the canonical JSON spelling required by the
      // JSON grammar, and Number.isSafeInteger(-0) intentionally accepts it.
      return JSON.stringify(value);
    }
    case "object": break;
    default: return invalid(path);
  }

  if (active.has(value)) invalid(path);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const length = value.length;
      const names = Object.getOwnPropertyNames(value);
      const symbols = Object.getOwnPropertySymbols(value);
      if (symbols.length > 0) invalid(path);
      for (const name of names) {
        if (name !== "length" && !isArrayIndex(name, length)) invalid(path);
      }
      const items: string[] = [];
      for (let index = 0; index < length; index += 1) {
        if (!Object.hasOwn(value, index)) invalid(path);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) invalid(path);
        items.push(encode(descriptor.value, `${path}[${index}]`, active));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(path);
    if (Object.getOwnPropertySymbols(value).length > 0) invalid(path);

    const entries: { readonly key: string; readonly value: unknown }[] = [];
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid(path);
      entries.push({ key, value: descriptor.value });
    }
    entries.sort((left, right) => utf8Compare(left.key, right.key));
    return `{${entries.map(({ key, value: child }) => `${JSON.stringify(key)}:${encode(child, `${path}.${key}`, active)}`).join(",")}}`;
  } finally {
    active.delete(value);
  }
}

/** Encode a value using the Studio v1 canonical JSON grammar. */
export function canonicalJson(value: unknown): string {
  return encode(value, "$", new WeakSet<object>());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateEnvelope(value: unknown): asserts value is PlanDigestEnvelope {
  if (!isPlainObject(value)) invalid("$");
  const keys = Object.getOwnPropertyNames(value).sort(utf8Compare);
  const expected = [...PLAN_DIGEST_FIELDS].sort(utf8Compare);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalid("$");
  if (Object.getOwnPropertySymbols(value).length > 0) invalid("$");
}

/** Compute the frozen Studio v1 plan digest. */
export function computePlanDigest(envelope: PlanDigestEnvelope): StudioPlanDigest {
  validateEnvelope(envelope);
  const serialized = canonicalJson(envelope);
  const hash = createHash("sha256");
  hash.update(`${STUDIO_PLAN_DIGEST_BASIS}\n${serialized}`, "utf8");
  return `${STUDIO_PLAN_DIGEST_PREFIX}${hash.digest("hex")}` as StudioPlanDigest;
}

// Names kept as small conveniences for service adapters and tests.  They all
// execute the same exact implementation and do not add a second digest basis.
export const digestPlan = computePlanDigest;
export const computeStudioPlanDigest = computePlanDigest;
export const canonicalizeJson = canonicalJson;
