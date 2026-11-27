import { dirname } from "node:path";

import { loadRasterCapability, RASTER_MAX_SVG_BYTES } from "../brand/raster-capability.js";
import { computeSha256 } from "../digests.js";
import { validateCanonicalSceneSvg } from "../scene/import-svg.js";
import {
  disposeIllustrationSource, revalidateIllustrationSource, verifyIllustrationSource,
} from "./carrier-source.js";
import {
  bindCarrierComparisonProcessor, probeMagickDerivativeCapability, renderCarrierDerivative,
} from "./derivative.js";
import {
  closeIllustrationDirectories, retainIllustrationDirectories, retainIllustrationFile,
  verifyIllustrationDirectories, verifyIllustrationFile,
} from "./retained-files.js";

type SvgVerificationCode =
  | "ILLUSTRATION_SVG_REFERENCE_MISMATCH"
  | "ILLUSTRATION_SVG_CANONICAL_REQUIRED"
  | "ILLUSTRATION_SVG_RASTER_UNAVAILABLE"
  | "ILLUSTRATION_SVG_RASTER_FAILED"
  | "ILLUSTRATION_SVG_MASTER_MISMATCH"
  | "ILLUSTRATION_SVG_COMPARISON_ENCODER_UNAVAILABLE"
  | "ILLUSTRATION_SVG_DERIVATIVE_MISMATCH";

class IllustrationSvgError extends Error {
  constructor(readonly code: SvgVerificationCode) {
    super("Reviewed SVG carrier verification failed.");
  }
}

/** Replay the reviewed SVG through the closed raster and derivative contracts. */
export async function verifyIllustrationCarrierSvg(
  directory: string, svgPath: string, compactPaths?: boolean, compareLocalEncoder = false,
) {
  const carrier = await verifyIllustrationSource(directory);
  try {
    const directories = await retainIllustrationDirectories(dirname(svgPath));
    try {
      const svg = await retainIllustrationFile(svgPath, RASTER_MAX_SVG_BYTES);
      try {
        await verifyIllustrationDirectories(directories);
        const reference = carrier.record.references.find((entry) => entry.id === "reviewed-svg");
        if (reference?.sha256 !== svg.sha256) {
          throw new IllustrationSvgError("ILLUSTRATION_SVG_REFERENCE_MISMATCH");
        }
        const checked = validateCanonicalSceneSvg(svg.bytes, compactPaths);
        if (checked.classification !== "SUPPORTED_IMPORT" || checked.scene === undefined) {
          throw new IllustrationSvgError("ILLUSTRATION_SVG_CANONICAL_REQUIRED");
        }
        const master = carrier.record.source;
        const { width, height } = master.dimensions;
        const artboard = checked.scene.artboard;
        const [, , gridWidth, gridHeight] = artboard.viewBox;
        const isArtboard = width === artboard.width && height === artboard.height;
        const isViewBox = width === gridWidth && height === gridHeight &&
          gridWidth * artboard.height === gridHeight * artboard.width;
        if (master.mime !== "image/png" || (!isArtboard && !isViewBox)) {
          throw new IllustrationSvgError("ILLUSTRATION_SVG_MASTER_MISMATCH");
        }
        const capability = await loadRasterCapability();
        if (!capability.available) throw new IllustrationSvgError("ILLUSTRATION_SVG_RASTER_UNAVAILABLE");
        const raster = await capability.adapter.renderSvg({
          canonicalSvgBytes: svg.bytes, width, height,
          backgroundRgba: null, alpha: "straight", fit: "contain-pad", colorSpace: "srgb",
        }).catch(() => { throw new IllustrationSvgError("ILLUSTRATION_SVG_RASTER_FAILED"); });
        const alpha = raster.rgba8.some((byte, index) => index % 4 === 3 && byte !== 255) ? "straight" : "opaque";
        const pngDigest = computeSha256(raster.pngBytes);
        if (master.sha256 !== pngDigest || master.byteLength !== raster.pngBytes.byteLength || master.alpha !== alpha) {
          throw new IllustrationSvgError("ILLUSTRATION_SVG_MASTER_MISMATCH");
        }
        const localEncoder = compareLocalEncoder ? await probeMagickDerivativeCapability() : undefined;
        if (localEncoder?.available === false) {
          throw new IllustrationSvgError("ILLUSTRATION_SVG_COMPARISON_ENCODER_UNAVAILABLE");
        }
        const comparisons: { derivativeId: string; savedRecipeDigest: string; replayRecipeDigest: string }[] = [];
        for (const [index, savedRecipe] of carrier.recipes.entries()) {
          let recipe = savedRecipe;
          if (localEncoder?.available) {
            recipe = bindCarrierComparisonProcessor(savedRecipe, localEncoder.processor);
            comparisons.push({
              derivativeId: savedRecipe.recipeId, savedRecipeDigest: savedRecipe.recipeDigest,
              replayRecipeDigest: recipe.recipeDigest,
            });
          }
          const rebuilt = await renderCarrierDerivative(raster.pngBytes, recipe);
          const saved = carrier.manifest.derivatives[index]!;
          if (rebuilt.sha256 !== saved.sha256 || rebuilt.byteLength !== saved.byteLength || rebuilt.alpha !== saved.alpha) {
            throw new IllustrationSvgError("ILLUSTRATION_SVG_DERIVATIVE_MISMATCH");
          }
        }
        await verifyIllustrationDirectories(directories);
        await verifyIllustrationFile(svg);
        await revalidateIllustrationSource(carrier);
        return {
          manifestDigest: carrier.manifest.manifestDigest,
          recordDigest: carrier.record.digest,
          svgDigest: svg.sha256,
          pngDigest,
          width,
          height,
          rendererBuildDigest: raster.descriptor.rendererBuildDigest,
          derivatives: carrier.manifest.derivatives,
          ...(localEncoder?.available ? {
            localEncoderComparison: { processor: localEncoder.processor, recipes: comparisons },
          } : {}),
        };
      } finally {
        await svg.handle.close().catch(() => undefined);
      }
    } finally {
      await closeIllustrationDirectories(directories);
    }
  } finally {
    await disposeIllustrationSource(carrier);
  }
}
