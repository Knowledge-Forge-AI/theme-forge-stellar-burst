import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { computeSha256 } from "../digests.js";
import { durableWrite, syncPath } from "../filesystem.js";
import { createIllustrationCarrierManifest, serializeIllustrationCarrierManifest } from "./carrier-v1.js";
import { disposeIllustrationSource, verifyIllustrationSource } from "./carrier-source.js";
import {
  canonicalRasterDerivativeRecipeJson, inspectRasterDerivativePayload,
  validateRasterDerivativeRecipe, type RasterDerivativeRecipeV1,
} from "./derivative.js";
import {
  closeIllustrationDirectories, illustrationAbsolutePath, retainIllustrationDirectories,
  verifyIllustrationDirectories,
} from "./retained-files.js";
import { serializeRasterIllustration, validateRasterIllustrationRecord } from "./v1.js";

export class IllustrationCarrierWriteError extends Error {
  constructor(readonly code: "ILLUSTRATION_CARRIER_INPUT_INVALID" | "ILLUSTRATION_CARRIER_WRITE_FAILED") {
    super("Illustration carrier creation failed."); this.name = "IllustrationCarrierWriteError";
  }
}

/** Fresh directory only. Invalid input is rejected before any output creation. */
export async function writeIllustrationCarrier(options: {
  readonly directory: string;
  readonly packageId: string;
  readonly revision: number;
  readonly record: unknown;
  readonly derivatives: readonly { readonly recipe: RasterDerivativeRecipeV1; readonly bytes: Uint8Array }[];
}): Promise<{ readonly manifestDigest: string; readonly recordDigest: string; readonly files: readonly { readonly path: string; readonly sha256: string }[] }> {
  const directory = illustrationAbsolutePath(options.directory);
  const prepared = new Map<string, Uint8Array>();
  let manifest: ReturnType<typeof createIllustrationCarrierManifest>;
  try {
    const record = validateRasterIllustrationRecord(options.record);
    if (!Array.isArray(options.derivatives) || options.derivatives.length < 1 || options.derivatives.length > 16) throw new Error();
    let total = 0;
    const derivatives = options.derivatives.map(({ recipe: candidate, bytes: input }) => {
      const recipe = validateRasterDerivativeRecipe(candidate);
      if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > 32 * 1048576) throw new Error();
      const bytes = new Uint8Array(input); total += bytes.byteLength;
      if (total > 30 * 1048576) throw new Error();
      const planned = record.exportRecipes.find(item => item.id === recipe.recipeId);
      if (!planned || recipe.sourceSha256 !== record.source.sha256 || recipe.sourceMime !== record.source.mime
          || planned.recipeSha256 !== recipe.recipeDigest || planned.mime !== recipe.output.mime
          || planned.width !== recipe.output.width || planned.height !== recipe.output.height) throw new Error();
      const inspected = inspectRasterDerivativePayload(bytes, recipe.output.mime);
      if (inspected.width !== recipe.output.width || inspected.height !== recipe.output.height
          || (planned.alpha === "opaque" && inspected.alpha !== "opaque")) throw new Error();
      const recipeName = `recipes/${recipe.recipeId}.json`;
      const payloadName = `derivatives/${recipe.recipeId}.${recipe.output.mime === "image/png" ? "png" : "webp"}`;
      if (prepared.has(recipeName) || prepared.has(payloadName)) throw new Error();
      prepared.set(recipeName, Buffer.from(canonicalRasterDerivativeRecipeJson(recipe)));
      prepared.set(payloadName, bytes);
      return { id: recipe.recipeId, recipeDigest: recipe.recipeDigest, mime: recipe.output.mime,
        sha256: computeSha256(bytes), byteLength: bytes.byteLength, width: inspected.width, height: inspected.height, alpha: inspected.alpha };
    });
    manifest = createIllustrationCarrierManifest({ packageId: options.packageId, illustrationId: record.illustrationId,
      revision: options.revision, recordDigest: record.digest, derivatives });
    prepared.set("manifest.json", Buffer.from(serializeIllustrationCarrierManifest(manifest)));
    prepared.set("record.json", Buffer.from(serializeRasterIllustration(record)));
    if ([...prepared.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0) > 32 * 1048576) throw new Error();
  } catch { throw new IllustrationCarrierWriteError("ILLUSTRATION_CARRIER_INPUT_INVALID"); }
  const parents = await retainIllustrationDirectories(dirname(directory));
  let outputDirectories: Awaited<ReturnType<typeof retainIllustrationDirectories>> = [];
  const children: Awaited<ReturnType<typeof retainIllustrationDirectories>>[] = [];
  try {
    await verifyIllustrationDirectories(parents);
    await mkdir(directory, { mode: 0o700 });
    outputDirectories = await retainIllustrationDirectories(directory);
    for (const child of ["recipes", "derivatives"]) {
      await verifyIllustrationDirectories(outputDirectories);
      await mkdir(join(directory, child), { mode: 0o700 });
      children.push(await retainIllustrationDirectories(join(directory, child)));
    }
    // This fresh directory is incomplete until the final verification succeeds.
    // Failures retain it for attended inspection, never delete unknown entries.
    for (const [name, bytes] of prepared) {
      await verifyIllustrationDirectories(outputDirectories);
      for (const child of children) await verifyIllustrationDirectories(child);
      await durableWrite(join(directory, name), bytes);
    }
    await syncPath(join(directory, "recipes")); await syncPath(join(directory, "derivatives")); await syncPath(directory);
    const verified = await verifyIllustrationSource(directory);
    await disposeIllustrationSource(verified);
    await verifyIllustrationDirectories(parents);
    await verifyIllustrationDirectories(outputDirectories);
    for (const child of children) await verifyIllustrationDirectories(child);
    return Object.freeze({ manifestDigest: manifest.manifestDigest, recordDigest: manifest.recordDigest,
      files: Object.freeze([...prepared].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([path, bytes]) => Object.freeze({ path, sha256: computeSha256(bytes) }))) });
  } catch { throw new IllustrationCarrierWriteError("ILLUSTRATION_CARRIER_WRITE_FAILED"); }
  finally { for (const child of children) await closeIllustrationDirectories(child); await closeIllustrationDirectories(outputDirectories); await closeIllustrationDirectories(parents); }
}
