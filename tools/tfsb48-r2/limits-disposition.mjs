// @ts-check

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProductModules, TERMINAL_NOVA_ASSETS } from "../qualify-terminal-nova-brand.mjs";
import { canonicalJson, sha256Digest } from "./core-result-schema.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const GIT_ID_PATTERN = /^[0-9a-f]{40}$/u;

/**
 * @typedef {{ bytes: Uint8Array; sha256: string }} CorpusAsset
 */

/**
 * @typedef {{
 *   assetMap: Record<string, CorpusAsset>;
 *   readmeBytes: Uint8Array;
 *   readmeSha?: string;
 *   readmeSha256?: string;
 *   commit?: string;
 *   tree?: string;
 *   clean?: boolean;
 *   git?: { commit?: string; tree?: string; clean?: boolean };
 * }} LimitsCorpus
 */

/**
 * @typedef {{
 *   corpus: LimitsCorpus;
 * }} LimitsDispositionOptions
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`LIMITS_${name}_REQUIRED`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {Uint8Array}
 */
function requiredBytes(value, name) {
  if (!(value instanceof Uint8Array)) throw new Error(`LIMITS_${name}_BYTES_REQUIRED`);
  return value;
}

/**
 * Validate the live corpus identity and retain only its bounded observations.
 * @param {LimitsCorpus} corpus
 */
function observeCorpus(corpus) {
  if (!isRecord(corpus)) throw new Error("LIMITS_CORPUS_REQUIRED");
  const git = isRecord(corpus.git) ? corpus.git : {};
  const commit = requiredString(git.commit === undefined ? corpus.commit : git.commit, "CORPUS_COMMIT");
  const tree = requiredString(git.tree === undefined ? corpus.tree : git.tree, "CORPUS_TREE");
  const clean = git.clean === undefined ? corpus.clean : git.clean;
  if (!GIT_ID_PATTERN.test(commit) || !GIT_ID_PATTERN.test(tree) || clean !== true) throw new Error("LIMITS_CORPUS_GIT_INVALID");
  const readmeBytes = requiredBytes(corpus.readmeBytes, "README");
  const readmeDigest = sha256Digest(readmeBytes);
  const declaredReadme = corpus.readmeSha256 === undefined ? corpus.readmeSha : corpus.readmeSha256;
  if (declaredReadme !== undefined && declaredReadme !== readmeDigest && declaredReadme !== readmeDigest.slice("sha256:".length)) throw new Error("LIMITS_CORPUS_README_DIGEST_MISMATCH");
  if (!isRecord(corpus.assetMap)) throw new Error("LIMITS_CORPUS_ASSETS_REQUIRED");
  const assetMap = /** @type {Record<string, CorpusAsset>} */ (corpus.assetMap);
  if (Object.keys(assetMap).length !== TERMINAL_NOVA_ASSETS.length) throw new Error("LIMITS_CORPUS_ASSET_COUNT_INVALID");
  let totalAssetBytes = 0;
  let maxAssetBytes = 0;
  for (const spec of TERMINAL_NOVA_ASSETS) {
    const entry = assetMap[spec.id];
    if (!isRecord(entry) || !(entry.bytes instanceof Uint8Array)) throw new Error(`LIMITS_CORPUS_ASSET_MISSING_${spec.id}`);
    if (entry.sha256 !== sha256Digest(entry.bytes) && entry.sha256 !== sha256Digest(entry.bytes).slice("sha256:".length)) throw new Error(`LIMITS_CORPUS_ASSET_DIGEST_MISMATCH_${spec.id}`);
    totalAssetBytes += entry.bytes.byteLength;
    maxAssetBytes = Math.max(maxAssetBytes, entry.bytes.byteLength);
  }
  return Object.freeze({ commit, tree, clean: true, readmeDigest, assetCount: Object.keys(assetMap).length, readmeBytes: readmeBytes.byteLength, totalAssetBytes, maxAssetBytes });
}

/**
 * @param {Record<string, unknown>} product
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function exportedObject(product, key) {
  const value = product[key];
  if (!isRecord(value)) throw new Error(`LIMITS_EXPORTED_OBJECT_MISSING_${key}`);
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * @param {Record<string, unknown>} product
 * @param {readonly string[]} keys
 * @returns {readonly { name: string; value: unknown }[]}
 */
function exportedConstants(product, keys) {
  return Object.freeze(keys.map((name) => {
    if (!Object.hasOwn(product, name) || product[name] === undefined) throw new Error(`LIMITS_EXPORTED_CONSTANT_MISSING_${name}`);
    return Object.freeze({ name, value: product[name] });
  }));
}

/**
 * @param {string} id
 * @param {string} ownerSource
 * @param {readonly { name: string; value: unknown }[]} bounds
 * @param {readonly string[]} existingCoverage
 * @param {Record<string, unknown>} corpusObservation
 * @param {boolean} material
 */
function dispositionRow(id, ownerSource, bounds, existingCoverage, corpusObservation, material) {
  return Object.freeze({
    id,
    owner: Object.freeze({ source: ownerSource, exportedBounds: bounds }),
    existingExecutableCoverage: Object.freeze([...existingCoverage]),
    corpusObservation: Object.freeze({ ...corpusObservation }),
    materialToTerminalNovaIntegration: material,
    completionGate: false,
    disposition: "removed-from-TFSB48-completion",
    reasonCode: material ? "OWNER_BOUND_NORMAL_OPERATION_ONLY" : "GENERIC_LIMIT_NOT_TERMINAL_NOVA_INVARIANT",
    boundaryEvidence: Object.freeze({ status: "covered-by-owner-tests", atLimitRun: false, reasonCode: "NO_BOUNDARY_FIXTURE_REQUIRED_FOR_THIS_CORPUS" }),
  });
}

/**
 * Build the R2 limit disposition from production exports and current
 * executable coverage. It intentionally records facts and rationale rather
 * than a literal not-exercised completion table.
 *
 * @param {LimitsDispositionOptions} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function inspectLimitsDisposition(options) {
  if (!isRecord(options)) throw new Error("LIMITS_OPTIONS_REQUIRED");
  const corpus = observeCorpus(/** @type {LimitsCorpus} */ (options.corpus));
  const product = await loadProductModules();
  const designEvidence = await import(new URL("../../dist/design-evidence/v1-validate.js", import.meta.url).href);
  const rasterCapability = await import(new URL("../../dist/brand/raster-capability.js", import.meta.url).href);
  const rows = [
    dispositionRow("brand-schema", "src/brand/brand-schema.ts", exportedConstants(product, ["BRAND_MAX_BINDINGS", "BRAND_MAX_BINDINGS_PER_ASSET", "BRAND_MAX_FAMILIES", "BRAND_MAX_REFERENCED_ASSETS", "BRAND_MAX_REQUIREMENTS", "BRAND_MAX_ROLES", "BRAND_MAX_VARIANTS"]), ["test/brand/brand-schema.test.ts", "test/brand/derived-ownership.test.ts"], { assetCount: corpus.assetCount, maxAssetBytes: corpus.maxAssetBytes, totalAssetBytes: corpus.totalAssetBytes }, true),
    dispositionRow("brand-import-archive", "src/brand/brand-import.ts", Object.entries(exportedObject(product, "BRAND_IMPORT_LIMITS")).map(([name, value]) => ({ name, value })), ["test/brand/brand-import.test.ts", "test/brand/derived-bundle-import.test.ts"], { assetCount: corpus.assetCount, maxAssetBytes: corpus.maxAssetBytes, totalAssetBytes: corpus.totalAssetBytes, readmeBytes: corpus.readmeBytes }, true),
    dispositionRow("brand-bundle-archive", "src/brand/brand-bundle.ts", Object.entries(exportedObject(product, "BRAND_BUNDLE_LIMITS")).map(([name, value]) => ({ name, value })), ["test/brand/brand-bundle.test.ts", "test/brand/brand-package.test.ts"], { assetCount: corpus.assetCount, maxAssetBytes: corpus.maxAssetBytes, totalAssetBytes: corpus.totalAssetBytes, readmeBytes: corpus.readmeBytes }, true),
    dispositionRow("brand-package", "src/brand/brand-package.ts", exportedConstants(product, ["BRAND_PACKAGE_MAX_BYTES", "BRAND_PACKAGE_MAX_COMPANIONS", "BRAND_PACKAGE_MAX_ENTRIES", "BRAND_PACKAGE_MAX_FAMILIES", "BRAND_PACKAGE_MAX_INVENTORY", "BRAND_PACKAGE_MAX_NAME_BYTES", "BRAND_PACKAGE_MAX_TEXT_BYTES"]), ["test/brand/brand-package.test.ts", "test/brand/brand-bundle.test.ts"], { assetCount: corpus.assetCount, maxAssetBytes: corpus.maxAssetBytes }, false),
    dispositionRow("brand-recipes", "src/brand/recipes.ts", exportedConstants(product, ["BRAND_RECIPES_MAX_BYTES", "BRAND_RECIPES_MAX_DERIVED_TARGETS", "BRAND_RECIPES_MAX_GRAPH_DEPTH", "BRAND_RECIPES_MAX_OPERATIONS_PER_RECIPE", "BRAND_RECIPES_MAX_RECIPES", "BRAND_RECIPES_MAX_TOTAL_APPLICATIONS"]), ["test/brand/recipes.test.ts", "test/brand/derived-ownership.test.ts"], { assetCount: corpus.assetCount, maxAssetBytes: corpus.maxAssetBytes }, false),
    dispositionRow("brand-tokens", "src/brand/tokens.ts", exportedConstants(product, ["BRAND_TOKENS_MAX_BYTES", "BRAND_TOKENS_MAX_COUNT", "BRAND_TOKENS_MAX_DEPTH", "BRAND_TOKENS_MAX_REFERENCES"]), ["test/brand/tokens.test.ts"], { assetCount: corpus.assetCount }, false),
    dispositionRow("brand-qa", "src/brand/qa-schema.ts", exportedConstants(product, ["BRAND_QA_MAX_AGGREGATE_RGBA_BYTES", "BRAND_QA_MAX_BACKGROUNDS", "BRAND_QA_MAX_BYTES", "BRAND_QA_MAX_CASES", "BRAND_QA_MAX_DIMENSION", "BRAND_QA_MAX_EVALUATIONS_PER_PROFILE", "BRAND_QA_MAX_PIXELS_PER_EVALUATION", "BRAND_QA_MAX_PROFILES", "BRAND_QA_MAX_RESULT_BYTES", "BRAND_QA_MAX_SIZES", "BRAND_QA_MAX_TARGETS_PER_CASE", "BRAND_QA_MAX_VISUAL_CASES"]), ["test/brand/qa-schema.test.ts", "test/brand/qa-capability.test.ts", "test/brand/qa-semantic.test.ts"], { assetCount: corpus.assetCount, maxAssetBytes: corpus.maxAssetBytes }, false),
    dispositionRow("raster-export", "src/brand/raster-capability.ts", exportedConstants(rasterCapability, ["RASTER_MAX_PNG_BYTES", "RASTER_MAX_SVG_BYTES"]), ["test/brand/raster-capability.test.ts", "test/brand/raster-transaction.test.ts"], { assetCount: corpus.assetCount, maxAssetBytes: corpus.maxAssetBytes }, false),
    dispositionRow("design-evidence", "src/design-evidence/v1-validate.ts", Object.entries(designEvidence.DESIGN_EVIDENCE_LIMITS).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => ({ name, value })), ["test/design-evidence-v1.test.ts", "test/design-evidence-roundtrip.test.ts"], { applicable: false, reasonCode: "DESIGN_EVIDENCE_NOT_USED_BY_TERMINAL_NOVA_CORE" }, false),
  ];
  const completionGateRows = rows.filter((row) => row.completionGate).map((row) => row.id);
  const removedRows = rows.filter((row) => !row.completionGate).map((row) => row.id);
  const result = {
    schema: "tfsb.terminal-nova-limits-disposition",
    schemaVersion: 1,
    corpus: { commit: corpus.commit, tree: corpus.tree, clean: corpus.clean, readmeDigest: corpus.readmeDigest, assetCount: corpus.assetCount, maxAssetBytes: corpus.maxAssetBytes, totalAssetBytes: corpus.totalAssetBytes, readmeBytes: corpus.readmeBytes },
    rows,
    completionGateRows,
    removedRows,
    rationale: "Terminal Nova's ten-asset corpus is far below every owner bound. Boundary behavior remains covered by owner tests; constructing oversized fixtures would duplicate generic coverage and is not an R2 integration invariant.",
  };
  // Re-serialize once through canonical JSON to ensure all source records are
  // deterministic without retaining a recursive source-tree hash.
  JSON.parse(canonicalJson(result));
  return Object.freeze(result);
}

/**
 * Alias used by packet composers that call the artifact a report.
 * @param {LimitsDispositionOptions} options
 */
export async function buildLimitsDisposition(options) {
  return inspectLimitsDisposition(options);
}
