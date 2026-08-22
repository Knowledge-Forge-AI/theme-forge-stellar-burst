import { createHash } from "node:crypto";

import { serializeAssetToml } from "./toml-writer.js";
import type { NormalizedAsset } from "./types.js";

export type Sha256Digest = `sha256:${string}`;

export const ASSET_DIGEST_BASIS = "tfsb-asset-toml-v1" as const;
export const PATH_DIGEST_BASIS = "tfsb-path-text-v1" as const;

export function computeRawSha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function computeSha256(bytes: string | Uint8Array): Sha256Digest {
  return `sha256:${computeRawSha256(bytes)}`;
}

/** Frozen schema-1 semantic digest. Do not redirect this to a future formatter. */
export function computeAssetSemanticDigest(asset: NormalizedAsset): Sha256Digest {
  return computeSha256(Buffer.from(serializeAssetToml(asset), "utf8"));
}

export function computeCompanionByteDigest(bytes: Uint8Array): Sha256Digest {
  return computeSha256(bytes);
}

/** Hashes the exact UTF-8 bytes of a validated model's normalized path text. */
export function computePathTextDigest(pathText: string): string {
  return computeRawSha256(Buffer.from(pathText, "utf8"));
}
