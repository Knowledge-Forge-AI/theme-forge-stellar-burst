import { opendir } from "node:fs/promises";
import { join } from "node:path";

import { parseDuplicateFreeJson } from "../brand/consumer-lock.js";
import { computeSha256 } from "../digests.js";
import {
  parseIllustrationCarrierManifest,
  type IllustrationCarrierManifestV1,
} from "./carrier-v1.js";
import {
  canonicalCarrierDerivativeRecipeJson, inspectRasterDerivativePayload,
  validateCarrierDerivativeRecipe, type CarrierDerivativeRecipe,
} from "./derivative.js";
import { parseRasterIllustration, type RasterIllustrationRecordV1 } from "./v1.js";
import {
  closeIllustrationDirectories, illustrationAbsolutePath, retainIllustrationDirectories,
  retainIllustrationFile, verifyIllustrationDirectories, verifyIllustrationFile,
  type RetainedIllustrationDirectory, type RetainedIllustrationFile,
} from "./retained-files.js";

export class IllustrationSourceError extends Error {
  constructor(readonly code: "ILLUSTRATION_SOURCE_INVALID" | "ILLUSTRATION_SOURCE_CHANGED" | "ILLUSTRATION_SOURCE_DISPOSED") {
    super("Illustration carrier verification failed."); this.name = "IllustrationSourceError";
  }
}

export interface VerifiedIllustrationSource {
  readonly manifest: IllustrationCarrierManifestV1;
  readonly record: RasterIllustrationRecordV1;
  readonly recipes: readonly CarrierDerivativeRecipe[];
}

interface SourceState {
  readonly directories: RetainedIllustrationDirectory[][];
  readonly inventories: { readonly path: string; readonly entries: readonly string[] }[];
  readonly files: RetainedIllustrationFile[];
  readonly payloads: Map<string, Uint8Array>;
  disposed: boolean;
}
const states = new WeakMap<VerifiedIllustrationSource, SourceState>();
const MAX_AGGREGATE = 32 * 1048576;
function invalid(): never { throw new IllustrationSourceError("ILLUSTRATION_SOURCE_INVALID"); }

async function inventory(path: string, expected: readonly string[]): Promise<void> {
  const names: string[] = [];
  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      names.push(entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || names.length > expected.length) invalid();
    }
    if (JSON.stringify(names.sort()) !== JSON.stringify([...expected].sort())) invalid();
  } catch (error) { if (error instanceof IllustrationSourceError) throw error; invalid(); }
}

function readRecipe(bytes: Uint8Array): CarrierDerivativeRecipe {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.startsWith("\uFEFF")) invalid();
    // Canonical recipes are shallow, closed objects. Bound nesting before the
    // existing duplicate-key parser sees caller-provided JSON.
    let depth = 0, quoted = false, escaped = false;
    for (const char of text) {
      if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") { if (++depth > 32) invalid(); }
      else if (char === "}" || char === "]") { if (--depth < 0) invalid(); }
    }
    const result = validateCarrierDerivativeRecipe(parseDuplicateFreeJson(text, { operation: "validate", domain: "cli" }));
    if (canonicalCarrierDerivativeRecipeJson(result) !== text) invalid();
    return result;
  } catch { invalid(); }
}

/** A closed saved-derivative directory; it never contains original masters. */
export async function verifyIllustrationSource(directoryInput: string): Promise<VerifiedIllustrationSource> {
  const directory = illustrationAbsolutePath(directoryInput);
  const directories: RetainedIllustrationDirectory[][] = [];
  const files: RetainedIllustrationFile[] = [];
  const inventories: { path: string; entries: readonly string[] }[] = [];
  let total = 0;
  const retain = async (relative: string, maximum: number): Promise<RetainedIllustrationFile> => {
    for (const chain of directories) await verifyIllustrationDirectories(chain);
    const file = await retainIllustrationFile(join(directory, relative), maximum);
    files.push(file); total += file.bytes.byteLength;
    if (total > MAX_AGGREGATE) invalid();
    return file;
  };
  try {
    directories.push([...await retainIllustrationDirectories(directory)]);
    const rootEntries = ["manifest.json", "record.json", "recipes", "derivatives"];
    await inventory(directory, rootEntries); inventories.push({ path: directory, entries: rootEntries });
    const manifest = parseIllustrationCarrierManifest((await retain("manifest.json", 262144)).bytes);
    const record = parseRasterIllustration((await retain("record.json", 1048576)).bytes);
    if (record.digest !== manifest.recordDigest || record.illustrationId !== manifest.illustrationId) invalid();
    const recipeNames = manifest.derivatives.map(item => `${item.id}.json`);
    const payloadNames = manifest.derivatives.map(item => `${item.id}.${item.mime === "image/png" ? "png" : "webp"}`);
    for (const [name, entries] of [["recipes", recipeNames], ["derivatives", payloadNames]] as const) {
      const path = join(directory, name);
      directories.push([...await retainIllustrationDirectories(path)]);
      await inventory(path, entries); inventories.push({ path, entries });
    }
    const payloads = new Map<string, Uint8Array>();
    const recipes: CarrierDerivativeRecipe[] = [];
    for (const item of manifest.derivatives) {
      const recipe = readRecipe((await retain(`recipes/${item.id}.json`, 262144)).bytes);
      const planned = record.exportRecipes.find(entry => entry.id === item.id);
      if (!planned || recipe.recipeId !== item.id || recipe.recipeDigest !== item.recipeDigest
          || planned.recipeSha256 !== item.recipeDigest || planned.mime !== item.mime
          || planned.width !== item.width || planned.height !== item.height
          || recipe.sourceSha256 !== record.source.sha256 || recipe.sourceMime !== record.source.mime
          || (recipe.schemaVersion === 3 && (recipe.sourceWidth !== record.source.dimensions.width
            || recipe.sourceHeight !== record.source.dimensions.height))
          || recipe.output.mime !== item.mime || recipe.output.width !== item.width || recipe.output.height !== item.height) invalid();
      const extension = item.mime === "image/png" ? "png" : "webp";
      const file = await retain(`derivatives/${item.id}.${extension}`, 32 * 1048576);
      if (file.bytes.byteLength !== item.byteLength || computeSha256(file.bytes) !== item.sha256) invalid();
      const inspected = inspectRasterDerivativePayload(file.bytes, item.mime);
      if (inspected.width !== item.width || inspected.height !== item.height || inspected.alpha !== item.alpha
          || (planned.alpha === "opaque" && inspected.alpha !== "opaque")) invalid();
      payloads.set(item.id, file.bytes); recipes.push(recipe);
    }
    for (const chain of directories) await verifyIllustrationDirectories(chain);
    for (const file of files) await verifyIllustrationFile(file);
    for (const entry of inventories) await inventory(entry.path, entry.entries);
    const source: VerifiedIllustrationSource = Object.freeze({ manifest, record, recipes: Object.freeze(recipes) });
    states.set(source, { directories, files, inventories, payloads, disposed: false });
    return source;
  } catch (error) {
    for (const file of files) await file.handle.close().catch(() => undefined);
    for (const chain of directories) await closeIllustrationDirectories(chain);
    if (error instanceof IllustrationSourceError) throw error;
    invalid();
  }
}

export async function revalidateIllustrationSource(source: VerifiedIllustrationSource): Promise<void> {
  const state = states.get(source);
  if (!state || state.disposed) throw new IllustrationSourceError("ILLUSTRATION_SOURCE_DISPOSED");
  try {
    for (const chain of state.directories) await verifyIllustrationDirectories(chain);
    for (const file of state.files) await verifyIllustrationFile(file);
    for (const entry of state.inventories) await inventory(entry.path, entry.entries);
    if (state.disposed) throw new IllustrationSourceError("ILLUSTRATION_SOURCE_DISPOSED");
  } catch { throw new IllustrationSourceError(state.disposed ? "ILLUSTRATION_SOURCE_DISPOSED" : "ILLUSTRATION_SOURCE_CHANGED"); }
}

export function getIllustrationPayload(source: VerifiedIllustrationSource, id: string): Uint8Array {
  const state = states.get(source);
  if (!state || state.disposed) throw new IllustrationSourceError("ILLUSTRATION_SOURCE_DISPOSED");
  const value = state.payloads.get(id);
  if (!value) invalid();
  return new Uint8Array(value);
}

/** Internal planner guard for case aliases and other retained directory aliases. */
export function isIllustrationSourceDirectory(source: VerifiedIllustrationSource, identity: { readonly dev: number; readonly ino: number }): boolean {
  const state = states.get(source);
  if (!state || state.disposed) throw new IllustrationSourceError("ILLUSTRATION_SOURCE_DISPOSED");
  return state.directories.some(chain => {
    const leaf = chain.at(-1);
    return leaf !== undefined && state.inventories.some(entry => entry.path === leaf.path)
      && leaf.identity.dev === identity.dev && leaf.identity.ino === identity.ino;
  });
}

export async function disposeIllustrationSource(source: VerifiedIllustrationSource): Promise<void> {
  const state = states.get(source);
  if (!state || state.disposed) return;
  state.disposed = true;
  for (const file of state.files) await file.handle.close().catch(() => undefined);
  for (const chain of state.directories) await closeIllustrationDirectories(chain);
  state.payloads.clear(); state.files.length = 0; state.directories.length = 0; state.inventories.length = 0;
}
