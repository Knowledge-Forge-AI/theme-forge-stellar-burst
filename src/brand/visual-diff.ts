import { computeSha256, type Sha256Digest } from "../digests.js";
import { encodeCanonicalJson } from "./brand-digests.js";
import { BRAND_QA_RENDER_CONFIGURATION, compareBrandQaRasters, renderBrandQaRaster, validateBrandQaRendererDescriptor, type BrandQaBounds, type BrandQaRasterBudget, type BrandQaRendererCapability, type BrandQaRendererDescriptor } from "./qa-capability.js";
import type { BrandQaBackground } from "./qa-schema.js";

export const BRAND_VISUAL_DIFF_SCHEMA = "tfsb.brand-visual-diff" as const;
export const BRAND_VISUAL_DIFF_SCHEMA_VERSION = 1 as const;
export const BRAND_VISUAL_DIFF_DIGEST_BASIS = "tfsb.brand-visual-diff-v1\n" as const;

export interface BrandVisualDiffInputIdentity {
  readonly canonicalAssetDigest: Sha256Digest;
  readonly modelDigest: Sha256Digest;
  readonly svgDigest: Sha256Digest;
  readonly canonicalSvgBytes: Uint8Array;
}

export interface BrandVisualDiffOptions {
  readonly caseId: string;
  readonly target: string;
  readonly before: BrandVisualDiffInputIdentity;
  readonly after: BrandVisualDiffInputIdentity;
  readonly renderer: BrandQaRendererCapability;
  readonly width: number;
  readonly height: number;
  readonly background: BrandQaBackground;
  readonly backgroundRgba: readonly [number, number, number, number] | null;
}

export interface BrandVisualDiffResult {
  readonly schema: typeof BRAND_VISUAL_DIFF_SCHEMA;
  readonly schemaVersion: typeof BRAND_VISUAL_DIFF_SCHEMA_VERSION;
  readonly caseId: string;
  readonly target: string;
  readonly before: { readonly canonicalAssetDigest: Sha256Digest; readonly modelDigest: Sha256Digest; readonly svgDigest: Sha256Digest };
  readonly after: { readonly canonicalAssetDigest: Sha256Digest; readonly modelDigest: Sha256Digest; readonly svgDigest: Sha256Digest };
  readonly renderer: BrandQaRendererDescriptor;
  readonly configuration: { readonly width: number; readonly height: number; readonly background: BrandQaBackground };
  readonly changedPixels: number;
  readonly maximumChannelDelta: number;
  readonly changedBounds: BrandQaBounds | null;
  readonly beforeDecodedPixelDigest: Sha256Digest;
  readonly afterDecodedPixelDigest: Sha256Digest;
  readonly beforePngDigest?: Sha256Digest;
  readonly afterPngDigest?: Sha256Digest;
  readonly deltaPngDigest?: Sha256Digest;
  readonly claim: "pixel-equal-for-this-renderer-and-case-only" | "pixel-different-for-this-renderer-and-case-only";
  readonly resultDigest: Sha256Digest;
}

export function computeBrandVisualDiffResultDigest(result: Omit<BrandVisualDiffResult, "resultDigest">): Sha256Digest {
  return computeSha256(Buffer.from(BRAND_VISUAL_DIFF_DIGEST_BASIS + encodeCanonicalJson(result), "utf8"));
}

export async function compareBrandVisuals(options: BrandVisualDiffOptions): Promise<BrandVisualDiffResult> {
  const descriptor = validateBrandQaRendererDescriptor(options.renderer.descriptor);
  const budget: BrandQaRasterBudget = { decodedRgbaBytes: 0 };
  const beforeRaster = await renderBrandQaRaster(options.renderer, { canonicalSvgBytes: options.before.canonicalSvgBytes, svgDigest: options.before.svgDigest, width: options.width, height: options.height, background: options.background, backgroundRgba: options.backgroundRgba, configuration: BRAND_QA_RENDER_CONFIGURATION }, budget);
  const afterRaster = await renderBrandQaRaster(options.renderer, { canonicalSvgBytes: options.after.canonicalSvgBytes, svgDigest: options.after.svgDigest, width: options.width, height: options.height, background: options.background, backgroundRgba: options.backgroundRgba, configuration: BRAND_QA_RENDER_CONFIGURATION }, budget);
  if (JSON.stringify(validateBrandQaRendererDescriptor(options.renderer.descriptor)) !== JSON.stringify(descriptor)) throw new Error("Renderer descriptor changed during visual diff.");
  const difference = compareBrandQaRasters(beforeRaster, afterRaster);
  const withoutDigest: Omit<BrandVisualDiffResult, "resultDigest"> = Object.freeze({
    schema: BRAND_VISUAL_DIFF_SCHEMA,
    schemaVersion: BRAND_VISUAL_DIFF_SCHEMA_VERSION,
    caseId: options.caseId,
    target: options.target,
    before: Object.freeze({ canonicalAssetDigest: options.before.canonicalAssetDigest, modelDigest: options.before.modelDigest, svgDigest: options.before.svgDigest }),
    after: Object.freeze({ canonicalAssetDigest: options.after.canonicalAssetDigest, modelDigest: options.after.modelDigest, svgDigest: options.after.svgDigest }),
    renderer: descriptor,
    configuration: Object.freeze({ width: options.width, height: options.height, background: options.background }),
    changedPixels: difference.changedPixels,
    maximumChannelDelta: difference.maximumChannelDelta,
    changedBounds: difference.changedBounds,
    beforeDecodedPixelDigest: difference.beforeDecodedPixelDigest,
    afterDecodedPixelDigest: difference.afterDecodedPixelDigest,
    ...(difference.beforePngDigest === undefined ? {} : { beforePngDigest: difference.beforePngDigest }),
    ...(difference.afterPngDigest === undefined ? {} : { afterPngDigest: difference.afterPngDigest }),
    claim: difference.changedPixels === 0 ? "pixel-equal-for-this-renderer-and-case-only" : "pixel-different-for-this-renderer-and-case-only",
  });
  return Object.freeze({ ...withoutDigest, resultDigest: computeBrandVisualDiffResultDigest(withoutDigest) });
}

export function serializeBrandVisualDiff(result: BrandVisualDiffResult): string {
  const { resultDigest: _ignored, ...withoutDigest } = result;
  if (computeBrandVisualDiffResultDigest(withoutDigest) !== result.resultDigest) throw new Error("Brand visual diff result digest is invalid.");
  return JSON.stringify(result, null, 2) + "\n";
}
