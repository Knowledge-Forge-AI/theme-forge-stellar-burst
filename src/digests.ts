import { createHash } from "node:crypto";

import { serializeAssetTomlV2 } from "./schema2-toml.js";
import type { NormalizedAssetV2 } from "./schema2-types.js";
import { serializeAssetToml } from "./toml-writer.js";
import type { NormalizedAsset } from "./types.js";

export type Sha256Digest = `sha256:${string}`;

export const ASSET_DIGEST_BASIS = "tfsb-asset-toml-v1" as const;
export const ASSET_DIGEST_BASIS_V2 = "tfsb-asset-toml-v2" as const;
export const PATH_DIGEST_BASIS = "tfsb-path-text-v1" as const;
export const SVG_OUTPUT_DIGEST_BASIS = "tfsb-svg-output-v1" as const;

export function computeRawSha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function computeSha256(bytes: string | Uint8Array): Sha256Digest {
  return `sha256:${computeRawSha256(bytes)}`;
}

/** Version-selected canonical semantic digest. The v1 branch remains frozen. */
export function computeAssetSemanticDigest(asset: NormalizedAsset | NormalizedAssetV2): Sha256Digest {
  const canonical = asset.schemaVersion === 1 ? serializeAssetToml(asset) : serializeAssetTomlV2(asset);
  return computeSha256(Buffer.from(canonical, "utf8"));
}

export function computeCompanionByteDigest(bytes: Uint8Array): Sha256Digest {
  return computeSha256(bytes);
}

/** SHA-256 over the exact canonical SVG UTF-8 bytes emitted by a frozen writer. */
export function computeSvgOutputDigest(svg: string | Uint8Array): Sha256Digest {
  return computeSha256(typeof svg === "string" ? Buffer.from(svg, "utf8") : svg);
}

/** Hashes the exact UTF-8 bytes of a validated model's normalized path text. */
export function computePathTextDigest(pathText: string): string {
  return computeRawSha256(Buffer.from(pathText, "utf8"));
}
