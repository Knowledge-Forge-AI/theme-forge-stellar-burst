import { computeSha256, type Sha256Digest } from "../digests.js";
import { compareUtf8 } from "../provenance.js";
import { BRAND_DIGEST_BASIS, BRAND_SYSTEM_DIGEST_BASIS } from "./brand-files.js";
import type { BrandModel } from "./brand-schema.js";

export function encodeCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Canonical JSON requires safe integers, got: " + value);
    }
    return value.toString();
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value) || value[i] === undefined) {
        throw new Error("Canonical JSON does not support sparse arrays or undefined elements");
      }
      items.push(encodeCanonicalJson(value[i]));
    }
    return "[" + items.join(",") + "]";
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("Canonical JSON only supports plain objects, got: " + Object.prototype.toString.call(value));
    }
    const keys = Object.keys(value as Record<string, unknown>).sort(compareUtf8);
    const entries: string[] = [];
    for (const key of keys) {
      const val = (value as Record<string, unknown>)[key];
      if (val === undefined) {
        continue;
      }
      entries.push(JSON.stringify(key) + ":" + encodeCanonicalJson(val));
    }
    return "{" + entries.join(",") + "}";
  }
  throw new Error("Canonical JSON cannot encode type: " + typeof value);
}

export function computeBrandDigest(model: BrandModel): Sha256Digest {
  const json = encodeCanonicalJson(model);
  const preimage = BRAND_DIGEST_BASIS + json;
  return computeSha256(Buffer.from(preimage, "utf8"));
}

export interface BrandSystemDigestInput {
  readonly brand: BrandModel;
  readonly tokens: unknown | null;
  readonly recipes: unknown | null;
  readonly qa: unknown | null;
  readonly consumerProfiles: unknown | null;
  readonly exports: unknown | null;
  readonly referencedAssets: readonly {
    readonly assetId: string;
    readonly canonicalAssetDigest: string;
  }[];
}

export function computeBrandSystemDigest(input: BrandSystemDigestInput): Sha256Digest {
  const sortedReferencedAssets = [...input.referencedAssets].sort((a, b) => compareUtf8(a.assetId, b.assetId));
  const root = {
    brand: input.brand,
    consumerProfiles: input.consumerProfiles ?? null,
    exports: input.exports ?? null,
    qa: input.qa ?? null,
    recipes: input.recipes ?? null,
    referencedAssets: sortedReferencedAssets,
    tokens: input.tokens ?? null,
  };
  const json = encodeCanonicalJson(root);
  const preimage = BRAND_SYSTEM_DIGEST_BASIS + json;
  return computeSha256(Buffer.from(preimage, "utf8"));
}
