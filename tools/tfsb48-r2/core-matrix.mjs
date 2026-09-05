// @ts-check

import { cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TERMINAL_NOVA_ASSETS,
  generateTerminalNovaBrandProject,
  loadProductModules,
} from "../qualify-terminal-nova-brand.mjs";
import {
  artifactIdentity,
  canonicalJson,
  createCaseRow,
  finalizeCoreMatrix,
  sha256Digest,
} from "./core-result-schema.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CORPUS_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

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
 * }} TerminalNovaCorpus
 */

/**
 * @typedef {{
 *   scratchRoot: string;
 *   corpus: TerminalNovaCorpus;
 * }} CoreMatrixOptions
 */

/**
 * @typedef {{
 *   commit: string;
 *   tree: string;
 *   clean: true;
 *   readmeDigest: string;
 *   readmeBytes: Uint8Array;
 *   assetMap: Record<string, CorpusAsset>;
 * }} ValidatedCorpus
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
 * @param {string} label
 * @returns {string}
 */
function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`CORE_${label}_REQUIRED`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Uint8Array}
 */
function requiredBytes(value, label) {
  if (!(value instanceof Uint8Array)) throw new Error(`CORE_${label}_BYTES_REQUIRED`);
  return value;
}

/**
 * @param {TerminalNovaCorpus} corpus
 * @returns {Promise<ValidatedCorpus>}
 */
async function validateCorpus(corpus) {
  if (!isRecord(corpus)) throw new Error("CORE_CORPUS_REQUIRED");
  const nestedGit = isRecord(corpus.git) ? corpus.git : {};
  const commit = requiredString(nestedGit.commit === undefined ? corpus.commit : nestedGit.commit, "CORPUS_COMMIT");
  const tree = requiredString(nestedGit.tree === undefined ? corpus.tree : nestedGit.tree, "CORPUS_TREE");
  const clean = nestedGit.clean === undefined ? corpus.clean : nestedGit.clean;
  if (!CORPUS_COMMIT_PATTERN.test(commit) || !CORPUS_COMMIT_PATTERN.test(tree)) throw new Error("CORE_CORPUS_GIT_IDENTITY_INVALID");
  if (clean !== true) throw new Error("CORE_CORPUS_NOT_CLEAN");
  const readmeBytes = requiredBytes(corpus.readmeBytes, "README");
  const readmeDigest = sha256Digest(readmeBytes);
  const declaredReadmeDigest = corpus.readmeSha256 === undefined ? corpus.readmeSha : corpus.readmeSha256;
  if (declaredReadmeDigest !== undefined && declaredReadmeDigest !== readmeDigest && declaredReadmeDigest !== readmeDigest.slice("sha256:".length)) {
    throw new Error("CORE_CORPUS_README_DIGEST_MISMATCH");
  }
  if (!isRecord(corpus.assetMap)) throw new Error("CORE_CORPUS_ASSETS_REQUIRED");
  const assetMap = /** @type {Record<string, CorpusAsset>} */ (corpus.assetMap);
  if (Object.keys(assetMap).length !== TERMINAL_NOVA_ASSETS.length) throw new Error("CORE_CORPUS_ASSET_COUNT_INVALID");
  for (const spec of TERMINAL_NOVA_ASSETS) {
    const entry = assetMap[spec.id];
    if (!isRecord(entry)) throw new Error(`CORE_CORPUS_ASSET_MISSING_${spec.id}`);
    const bytes = requiredBytes(entry.bytes, `ASSET_${spec.id}`);
    const digest = sha256Digest(bytes);
    if (entry.sha256 !== digest && entry.sha256 !== digest.slice("sha256:".length)) throw new Error(`CORE_CORPUS_ASSET_DIGEST_MISMATCH_${spec.id}`);
  }
  return { commit, tree, clean: true, readmeDigest, readmeBytes, assetMap };
}

/**
 * Read the authoritative plan registry from the current production source and
 * compare it with the built production module. This deliberately has no
 * copied list of methods, so a protocol change cannot silently pass here.
 * @returns {Promise<readonly string[]>}
 */
export async function derivePlanMethods() {
  const source = await readFile(join(REPO_ROOT, "src/service-protocol/v1-registry.ts"), "utf8");
  const match = /export const BRAND_PLAN_METHODS = \[([\s\S]*?)\] as const;/u.exec(source);
  if (match === null) throw new Error("CORE_PLAN_REGISTRY_SOURCE_MISSING");
  const registryBody = match[1];
  if (registryBody === undefined) throw new Error("CORE_PLAN_REGISTRY_SOURCE_MISSING");
  const sourceMethods = [...registryBody.matchAll(/"([a-z0-9.-]+)"/gu)].map((entry) => {
    const method = entry[1];
    if (method === undefined) throw new Error("CORE_PLAN_REGISTRY_METHOD_INVALID");
    return method;
  });
  if (sourceMethods.length === 0) throw new Error("CORE_PLAN_REGISTRY_EMPTY");
  const built = await import(new URL("../../dist/service-protocol/v1-registry.js", import.meta.url).href);
  const builtMethods = built.BRAND_PLAN_METHODS;
  if (!Array.isArray(builtMethods) || JSON.stringify(sourceMethods) !== JSON.stringify(builtMethods)) {
    throw new Error("CORE_PLAN_REGISTRY_SOURCE_BUILD_MISMATCH");
  }
  return Object.freeze([...sourceMethods]);
}

/**
 * Compatibility name for callers migrating from the R1 tool. The returned
 * registry contains only the methods actually owned by the production brand
 * protocol; non-brand workflow names are not invented here.
 * @returns {Promise<{ source: "production:BRAND_PLAN_METHODS"; methods: readonly string[]; total: number }>}
 */
export async function derivePlanFamiliesRegistry() {
  const methods = await derivePlanMethods();
  return Object.freeze({ source: "production:BRAND_PLAN_METHODS", methods, total: methods.length });
}

/**
 * Load the repository's fixed resvg adapter through the same explicit seam as
 * the accepted R1 qualification. The package is private workspace content,
 * not an installed npm dependency, so the product's package-name probe alone
 * cannot authenticate this lane.
 * @returns {Promise<({available: true, adapter: {descriptor: {adapterId: string, rendererVersion: string}, renderSvg: Function}} | {available: false, code?: string, reason?: string})>}
 */
async function loadFixedRasterCapability() {
  const resvgModule = await import("../../packages/tfsb-raster-resvg/index.js");
  const { createRasterCapabilityFromModule } = await import(new URL("../../dist/brand/raster-capability.js", import.meta.url).href);
  return createRasterCapabilityFromModule(resvgModule);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function diagnosticCode(error) {
  if (isRecord(error)) {
    const diagnostic = isRecord(error.diagnostic) ? error.diagnostic : undefined;
    const diagnosticValue = diagnostic === undefined ? undefined : diagnostic.code;
    if (typeof diagnosticValue === "string" && diagnosticValue.length > 0) return diagnosticValue;
    if (typeof error.symbolicCode === "string" && error.symbolicCode.length > 0) return error.symbolicCode;
    if (typeof error.code === "string" && error.code.length > 0 && /^[A-Z0-9_]+$/u.test(error.code)) return error.code;
  }
  return "UNCLASSIFIED_ERROR";
}

/**
 * @param {string} id
 * @param {() => Promise<import("./core-result-schema.mjs").CoreCaseRow> | Promise<Record<string, unknown>>} operation
 * @returns {Promise<import("./core-result-schema.mjs").CoreCaseRow>}
 */
async function runPositiveCase(id, operation) {
  try {
    const result = await operation();
    return /** @type {import("./core-result-schema.mjs").CoreCaseRow} */ (result);
  } catch (error) {
    return createCaseRow({ id, status: "fail", reasonCode: `UNEXPECTED_${diagnosticCode(error)}`, observations: { diagnosticCode: diagnosticCode(error) } });
  }
}

/**
 * @param {string} id
 * @param {readonly string[]} expectedCodes
 * @param {() => Promise<unknown>} operation
 * @returns {Promise<import("./core-result-schema.mjs").CoreCaseRow>}
 */
async function runExpectedFailureCase(id, expectedCodes, operation) {
  let observedCode;
  try {
    await operation();
  } catch (error) {
    observedCode = diagnosticCode(error);
  }
  if (observedCode === undefined) {
    return createCaseRow({ id, status: "fail", reasonCode: "EXPECTED_FAILURE_NOT_OBSERVED", observations: { expectedCodes: [...expectedCodes] } });
  }
  if (!expectedCodes.includes(observedCode)) {
    return createCaseRow({ id, status: "fail", reasonCode: "UNEXPECTED_DIAGNOSTIC", observations: { expectedCodes: [...expectedCodes], observedCode } });
  }
  return createCaseRow({ id, status: "pass", reasonCode: "EXPECTED_DIAGNOSTIC_OBSERVED", observations: { observedCode } });
}

/**
 * @param {string} id
 * @param {string} reasonCode
 * @param {Record<string, unknown>} observations
 * @returns {import("./core-result-schema.mjs").CoreCaseRow}
 */
function unavailableCase(id, reasonCode, observations) {
  return createCaseRow({ id, status: "unavailable", reasonCode, observations });
}

/**
 * @param {string} root
 * @param {string} name
 * @param {Record<string, CorpusAsset>} assetMap
 * @param {Uint8Array} readmeBytes
 * @returns {Promise<string>}
 */
async function copyGeneratedProject(root, name, assetMap, readmeBytes) {
  const target = join(root, "projects", name);
  await cp(join(root, "projects", "base"), target, { recursive: true, force: false, errorOnExist: true });
  return target;
}

/**
 * @param {string} root
 * @param {string} name
 * @returns {Promise<string>}
 */
async function createConsumerProject(root, name) {
  const target = join(root, "consumers", name);
  await mkdir(join(target, ".tfsb", "assets"), { recursive: true });
  await writeFile(join(target, ".tfsb", "project.toml"), 'schema_version = 2\nname = "terminal-nova-consumer"\n\n[build]\ndirectory = "dist"\n', "utf8");
  return target;
}

/**
 * Snapshot a generated project using only relative names and bytes. This is
 * bounded to the temporary project and is used only to prove transaction
 * rollback restored the exact pre-operation state.
 * @param {string} root
 * @returns {Promise<Uint8Array>}
 */
async function snapshotTemporaryTree(root) {
  /** @type {string[]} */
  const entries = [];
  /** @param {string} directory */
  const visit = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const full = join(directory, child.name);
      const rel = relative(root, full).split("\\").join("/");
      const info = await lstat(full);
      const mode = (info.mode & 0o7777).toString(8).padStart(4, "0");
      if (child.isDirectory()) {
        entries.push(`d:${mode}:${rel}`);
        await visit(full);
      } else if (child.isFile()) {
        const bytes = await readFile(full);
        entries.push(`f:${mode}:${rel}:${sha256Digest(bytes)}:${bytes.byteLength}`);
      } else {
        throw new Error("CORE_TEMPORARY_UNSAFE_ENTRY");
      }
    }
  };
  await visit(root);
  return Buffer.from(entries.join("\n") + "\n", "utf8");
}

/**
 * Remove scratch locators from plan material before hashing it. The plan bytes
 * stay packet-local; only their digest and size enter the durable result.
 * @param {unknown} value
 * @param {string} scratchRoot
 * @returns {unknown}
 */
function portablePlanValue(value, scratchRoot) {
  if (typeof value === "string") return value.split(scratchRoot).join("<scratch>");
  if (Array.isArray(value)) return value.map((child) => portablePlanValue(child, scratchRoot));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, portablePlanValue(child, scratchRoot)]));
  }
  return value;
}

/** @param {string} id @param {unknown} plan @param {string} scratchRoot */
function planArtifact(id, plan, scratchRoot) {
  return artifactIdentity("planned-operation", id, canonicalJson(portablePlanValue(plan, scratchRoot)));
}

/**
 * Bind an expected rejection to the exact mode-aware state observed before
 * and after the rejected operation, plus the normalized plan or request.
 * @param {string} id
 * @param {string} root
 * @param {unknown} plan
 * @param {readonly string[]} expectedCodes
 * @param {() => Promise<unknown>} operation
 * @param {string} scratchRoot
 */
async function runStateBoundRejection(id, root, plan, expectedCodes, operation, scratchRoot) {
  const before = await snapshotTemporaryTree(root);
  const result = await runExpectedFailureCase(id, expectedCodes, operation);
  const after = await snapshotTemporaryTree(root);
  if (result.status !== "pass" || Buffer.compare(before, after) !== 0) throw new Error(`CORE_${id.toUpperCase().replaceAll("-", "_")}_STATE_CHANGED`);
  return createCaseRow({
    ...result,
    observations: { ...result.observations, exactStatePreserved: true },
    artifacts: [
      artifactIdentity("tree-state", `${id}-before`, before),
      planArtifact(`${id}-plan`, plan, scratchRoot),
      artifactIdentity("tree-state", `${id}-after`, after),
    ],
  });
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @param {string} kind
 * @param {string} id
 * @returns {Promise<import("./core-result-schema.mjs").CoreArtifactIdentity>}
 */
async function fileArtifact(root, relativePath, kind, id) {
  return artifactIdentity(kind, id, await readFile(join(root, ...relativePath.split("/"))));
}

/**
 * @param {string} id
 * @param {string} reasonCode
 * @param {Record<string, unknown>} observations
 * @param {readonly import("./core-result-schema.mjs").CoreArtifactIdentity[]} artifacts
 * @returns {import("./core-result-schema.mjs").CoreCaseRow}
 */
function passCase(id, reasonCode, observations, artifacts = []) {
  return createCaseRow({ id, status: "pass", reasonCode, observations, artifacts });
}

/**
 * Execute the justified Terminal Nova integration matrix against isolated,
 * generated projects. Every mutating case reports bounded artifact identity;
 * source and consumer paths never leave this function.
 *
 * @param {CoreMatrixOptions} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function executeTerminalNovaCoreMatrix(options) {
  if (!isRecord(options)) throw new Error("CORE_OPTIONS_REQUIRED");
  const scratchRoot = requiredString(options.scratchRoot, "SCRATCH_ROOT");
  const corpus = await validateCorpus(/** @type {TerminalNovaCorpus} */ (options.corpus));
  const methods = await derivePlanMethods();
  const product = await loadProductModules();
  await mkdir(scratchRoot, { recursive: true });
  const realScratch = await realpath(scratchRoot);
  await rm(realScratch, { recursive: true, force: true });
  await mkdir(join(realScratch, "projects", "base"), { recursive: true });
  await mkdir(join(realScratch, "consumers"), { recursive: true });
  await generateTerminalNovaBrandProject(join(realScratch, "projects", "base"), corpus.assetMap, corpus.readmeBytes);

  // Confirm the generated project retained the exact corpus README bytes.
  const baseReadme = await readFile(join(realScratch, "projects", "base", "brand", "README.md"));
  if (sha256Digest(baseReadme) !== corpus.readmeDigest || Buffer.compare(baseReadme, corpus.readmeBytes) !== 0) throw new Error("CORE_GENERATED_README_MISMATCH");
  const rows = [];
  rows.push(passCase("corpus-authentication", "LIVE_CORPUS_AUTHENTICATED", { commit: corpus.commit, tree: corpus.tree, clean: corpus.clean, assetCount: Object.keys(corpus.assetMap).length, readmeDigest: corpus.readmeDigest }, [artifactIdentity("corpus-readme", "README.md", corpus.readmeBytes), ...Object.entries(corpus.assetMap).sort(([left], [right]) => left.localeCompare(right)).map(([id, entry]) => artifactIdentity("corpus-asset", id, entry.bytes))]));

  /** @type {{ path: string; bytes: Uint8Array } | undefined} */
  let bundle;
  const bundleCreate = await runPositiveCase("bundle-create-validate-import", async () => {
    const producer = await copyGeneratedProject(realScratch, "bundle-producer", corpus.assetMap, corpus.readmeBytes);
    const bundlePath = join(producer, "terminal-nova-brand-bundle.zip");
    const producerBefore = await snapshotTemporaryTree(producer);
    const bundlePlan = await product.planBrandBundle({ root: producer, output: "terminal-nova-brand-bundle.zip" });
    const bundleResult = await product.executeBrandBundle(bundlePlan);
    if (bundleResult.written !== true) throw new Error("CORE_BUNDLE_NOT_WRITTEN");
    const bundleBytes = await readFile(bundlePath);
    bundle = { path: bundlePath, bytes: new Uint8Array(bundleBytes) };
    const importRoot = join(realScratch, "projects", "bundle-import");
    await mkdir(importRoot, { recursive: true });
    const importBefore = await snapshotTemporaryTree(importRoot);
    const importPlan = await product.planBrandImport({ root: importRoot, archive: bundlePath });
    await product.executeBrandImport(importPlan);
    const importedCheck = await product.checkProject(importRoot);
    if (importedCheck.valid !== true || importedCheck.brand?.completenessSatisfied !== true) throw new Error("CORE_IMPORTED_PROJECT_INVALID");
    const rebundlePlan = await product.planBrandBundle({ root: importRoot, output: "terminal-nova-brand-rebundle.zip" });
    const rebundleResult = await product.executeBrandBundle(rebundlePlan);
    if (rebundleResult.written !== true) throw new Error("CORE_REBUNDLE_NOT_WRITTEN");
    const rebundleBytes = await readFile(join(importRoot, "terminal-nova-brand-rebundle.zip"));
    const producerAfter = await snapshotTemporaryTree(producer);
    const importAfter = await snapshotTemporaryTree(importRoot);
    return passCase("bundle-create-validate-import", "BUNDLE_CREATED_IMPORTED_AND_REBUNDLED", { packageId: bundleResult.packageId, assetCount: bundleResult.assetCount, companionCount: bundleResult.companionCount, importedBrandComplete: importedCheck.brand.completenessSatisfied, rebundled: rebundleResult.written, rebundleByteLength: rebundleBytes.byteLength }, [artifactIdentity("tree-state", "bundle-producer-before", producerBefore), planArtifact("bundle-create-plan", bundlePlan, realScratch), artifactIdentity("tree-state", "bundle-producer-after", producerAfter), artifactIdentity("tree-state", "bundle-import-before", importBefore), planArtifact("bundle-import-plan", importPlan, realScratch), artifactIdentity("tree-state", "bundle-import-after", importAfter), artifactIdentity("bundle", "terminal-nova-brand-bundle.zip", bundleBytes), artifactIdentity("bundle", "terminal-nova-brand-rebundle.zip", rebundleBytes), await fileArtifact(importRoot, ".tfsb/brand-package.toml", "imported-file", "imported-brand-package.toml")]);
  });
  rows.push(bundleCreate);

  rows.push(await runPositiveCase("derive-source-owned-noop", async () => {
    const projectRoot = await copyGeneratedProject(realScratch, "derive-noop", corpus.assetMap, corpus.readmeBytes);
    const plan = await product.planBrandDerivation({ root: projectRoot, all: true });
    if (plan.affectedTargets.length !== 0) throw new Error("CORE_DERIVE_EXPECTED_NO_TARGETS");
    const result = await product.executeBrandDerivationPlan(plan);
    if (result.written !== false || result.targetsWritten.length !== 0 || result.receiptsWritten.length !== 0) throw new Error("CORE_DERIVE_WROTE_SOURCE_OWNED_TARGET");
    return passCase("derive-source-owned-noop", "SOURCE_OWNED_DERIVE_NOOP", { affectedTargets: plan.affectedTargets.length, written: result.written });
  }));

  rows.push(await runPositiveCase("qa-semantic-validation", async () => {
    const projectRoot = await copyGeneratedProject(realScratch, "qa-semantic", corpus.assetMap, corpus.readmeBytes);
    const checked = await product.checkProject(projectRoot);
    const qa = checked.brand?.qa;
    if (checked.valid !== true || checked.brand?.completenessSatisfied !== true || qa === undefined || qa.semanticFail !== 0 || qa.semanticError !== 0) throw new Error("CORE_QA_SEMANTIC_FAILED");
    return passCase("qa-semantic-validation", "SEMANTIC_QA_PASSED", { completenessSatisfied: checked.brand.completenessSatisfied, semanticPass: qa.semanticPass, semanticFail: qa.semanticFail, semanticError: qa.semanticError, profiles: qa.profiles, cases: qa.cases });
  }));

  rows.push(await runPositiveCase("destination-topology", async () => {
    const expected = { zero: ["mark-monochrome-dark", "mark-monochrome-light"], one: ["favicon-on-dark"], multiple: ["favicon-on-light"] };
    const destinations = Object.fromEntries(TERMINAL_NOVA_ASSETS.map((asset) => [asset.id, asset.destinations.length]));
    const actual = { zero: expected.zero.filter((id) => destinations[id] !== undefined && destinations[id] === 0), one: expected.one.filter((id) => destinations[id] !== undefined && destinations[id] === 1), multiple: expected.multiple.filter((id) => destinations[id] !== undefined && destinations[id] > 1) };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("CORE_DESTINATION_TOPOLOGY_MISMATCH");
    return passCase("destination-topology", "CANONICAL_MANIFEST_ZERO_ONE_MULTIPLE_DESTINATIONS", { scope: "canonical-manifest-topology", zero: actual.zero, one: actual.one, multiple: actual.multiple });
  }));

  rows.push(await runPositiveCase("recipe-rejection-source-ownership", async () => {
    const projectRoot = await copyGeneratedProject(realScratch, "recipe-rejection", corpus.assetMap, corpus.readmeBytes);
    const brandText = await readFile(join(projectRoot, ".tfsb", "brand.toml"), "utf8");
    const recipePath = join(projectRoot, ".tfsb", "brand-recipes.toml");
    const recipeText = `schema = "tfsb.brand-recipes"\nschema_version = 1\n\n[[recipes]]\nid = "attempt-source-owned-mark"\ntarget_asset = "mark-monochrome-dark"\nsource_asset = "theme-forge-terminal-nova-mark-on-light"\n\n[[recipes.operations]]\noperation = "copy-accessibility"\npolicy = "preserve"\n`;
    await writeFile(recipePath, recipeText, "utf8");
    const result = await runStateBoundRejection("recipe-rejection-source-ownership", projectRoot, { operation: "planBrandDerivation", all: true }, ["DERIVED_OWNERSHIP_CONFLICT", "DERIVED_TARGET_OWNED_BY_HUMAN"], async () => product.planBrandDerivation({ root: projectRoot, all: true }), realScratch);
    const parsedBrand = product.parseBrandToml(brandText);
    if (!parsedBrand.ok || parsedBrand.value.bindings.filter(/** @type {(binding: { authority?: unknown }) => boolean} */ (binding) => binding.authority === "source").length !== TERMINAL_NOVA_ASSETS.length) throw new Error("CORE_SOURCE_AUTHORITY_CHANGED");
    if (result.status !== "pass") throw new Error(`CORE_RECIPE_REJECTION_${result.reasonCode}`);
    return result;
  }));

  rows.push(await runPositiveCase("consumer-install-clean-sync", async () => {
    if (bundle === undefined) return unavailableCase("consumer-install-clean-sync", "BUNDLE_ARTIFACT_UNAVAILABLE", { dependency: "bundle-create-validate-import" });
    const consumerRoot = await createConsumerProject(realScratch, "install-clean-sync");
    const before = await snapshotTemporaryTree(consumerRoot);
    const installPlan = await product.planConsumerInstall({ root: consumerRoot, sourceBundles: [bundle.path], profiles: ["terminal-nova/astro-starlight"] });
    const installResult = await product.executeConsumerInstallPlan(installPlan);
    if (installResult.writtenOutputs <= 0) throw new Error("CORE_CONSUMER_INSTALL_WROTE_NO_OUTPUTS");
    const lockBytes = await readFile(join(consumerRoot, ".tfsb", "brand.lock.json"));
    const syncPlan = await product.planConsumerSync({ root: consumerRoot, sourceBundles: [bundle.path] });
    const syncResult = await product.executeConsumerSyncPlan(syncPlan);
    if (syncResult.writtenOutputs !== 0) throw new Error("CORE_CLEAN_SYNC_WROTE_OUTPUTS");
    const state = await product.inspectConsumerState({ root: consumerRoot, sourceBundles: [bundle.path] });
    if (state.status !== "ok" || state.packages.length !== 1 || state.packages[0].sourceKind !== "local-bundle") throw new Error("CORE_LOCAL_CONSUMER_STATE_INVALID");
    const after = await snapshotTemporaryTree(consumerRoot);
    return passCase("consumer-install-clean-sync", "INSTALL_AND_CLEAN_SYNC_PASSED", { installedOutputs: installResult.writtenOutputs, cleanSyncOutputs: syncResult.writtenOutputs, state: state.status, sourceKind: state.packages[0].sourceKind }, [artifactIdentity("tree-state", "consumer-install-before", before), planArtifact("consumer-install-plan", installPlan, realScratch), planArtifact("consumer-clean-sync-plan", syncPlan, realScratch), artifactIdentity("tree-state", "consumer-clean-sync-after", after), artifactIdentity("consumer-lock", "install-clean-sync-brand.lock.json", lockBytes)]);
  }));

  rows.push(await runPositiveCase("offline-local-bundle-consumer", async () => {
    if (bundle === undefined) return unavailableCase("offline-local-bundle-consumer", "BUNDLE_ARTIFACT_UNAVAILABLE", { dependency: "bundle-create-validate-import" });
    const consumerRoot = await createConsumerProject(realScratch, "offline-local-bundle");
    const before = await snapshotTemporaryTree(consumerRoot);
    const plan = await product.planConsumerInstall({ root: consumerRoot, sourceBundles: [bundle.path], profiles: ["terminal-nova/astro-starlight"] });
    const result = await product.executeConsumerInstallPlan(plan);
    const state = await product.inspectConsumerState({ root: consumerRoot, sourceBundles: [bundle.path] });
    if (result.writtenOutputs <= 0 || state.status !== "ok" || state.packages[0]?.sourceKind !== "local-bundle") throw new Error("CORE_OFFLINE_LOCAL_BUNDLE_FAILED");
    const after = await snapshotTemporaryTree(consumerRoot);
    return passCase("offline-local-bundle-consumer", "LOCAL_BUNDLE_SOURCE_ONLY_NOT_NETWORK_DENIAL", { scope: "local-bundle-source-kind", writtenOutputs: result.writtenOutputs, sourceKind: state.packages[0].sourceKind, networkDenialOwnedBy: "npm-packed-offline-consumer" }, [artifactIdentity("tree-state", "local-bundle-before", before), planArtifact("local-bundle-plan", plan, realScratch), artifactIdentity("tree-state", "local-bundle-after", after)]);
  }));

  rows.push(await runPositiveCase("unowned-collision", async () => {
    if (bundle === undefined) return unavailableCase("unowned-collision", "BUNDLE_ARTIFACT_UNAVAILABLE", { dependency: "bundle-create-validate-import" });
    const availableBundle = bundle;
    const consumerRoot = await createConsumerProject(realScratch, "unowned-collision");
    const destination = join(consumerRoot, "docs", "public", "favicon-on-dark.svg");
    await mkdir(join(consumerRoot, "docs", "public"), { recursive: true });
    await writeFile(destination, "unowned collision\n", "utf8");
    return runStateBoundRejection("unowned-collision", consumerRoot, { operation: "planConsumerInstall", profiles: ["terminal-nova/astro-starlight"] }, ["CONSUMER_COLLISION"], async () => product.planConsumerInstall({ root: consumerRoot, sourceBundles: [availableBundle.path], profiles: ["terminal-nova/astro-starlight"] }), realScratch);
  }));

  rows.push(await runPositiveCase("source-drift", async () => {
    const projectRoot = await copyGeneratedProject(realScratch, "source-drift", corpus.assetMap, corpus.readmeBytes);
    const output = "source-drift.zip";
    const plan = await product.planBrandBundle({ root: projectRoot, output });
    const sourcePath = join(projectRoot, "brand", "README.md");
    const original = await readFile(sourcePath);
    await writeFile(sourcePath, Buffer.concat([original, Buffer.from("\nsource drift\n", "utf8")]));
    const result = await runStateBoundRejection("source-drift", projectRoot, plan, ["COMPANION_SOURCE_CHANGED"], async () => product.executeBrandBundle(plan), realScratch);
    await writeFile(sourcePath, original);
    return result;
  }));

  rows.push(await runPositiveCase("stale-plan", async () => {
    const projectRoot = await copyGeneratedProject(realScratch, "stale-plan", corpus.assetMap, corpus.readmeBytes);
    const output = "stale-plan.zip";
    const plan = await product.planBrandBundle({ root: projectRoot, output });
    const assetPath = join(projectRoot, ".tfsb", "assets", "favicon-on-dark.toml");
    const original = await readFile(assetPath);
    await writeFile(assetPath, Buffer.concat([original, Buffer.from("\n", "utf8")]));
    const result = await runStateBoundRejection("stale-plan", projectRoot, plan, ["BUNDLE_TRANSACTION_FAILED", "CANONICAL_CHANGED_DURING_PLAN"], async () => product.executeBrandBundle(plan), realScratch);
    await writeFile(assetPath, original);
    return result;
  }));

  /** @type {string | undefined} */
  let installedRoot;
  if (bundle !== undefined) {
    installedRoot = await createConsumerProject(realScratch, "shared-installed");
    const installPlan = await product.planConsumerInstall({ root: installedRoot, sourceBundles: [bundle.path], profiles: ["terminal-nova/astro-starlight"] });
    await product.executeConsumerInstallPlan(installPlan);
  }

  rows.push(await runPositiveCase("destination-drift", async () => {
    if (bundle === undefined || installedRoot === undefined) return unavailableCase("destination-drift", "CONSUMER_ARTIFACT_UNAVAILABLE", { dependency: "consumer-install-clean-sync" });
    const availableBundle = bundle;
    const availableInstalledRoot = installedRoot;
    const destination = join(availableInstalledRoot, "docs", "public", "favicon-on-dark.svg");
    const original = await readFile(destination);
    await writeFile(destination, "destination drift\n", "utf8");
    const result = await runStateBoundRejection("destination-drift", availableInstalledRoot, { operation: "planConsumerSync", expected: "CONSUMER_DRIFT" }, ["CONSUMER_DRIFT"], async () => product.planConsumerSync({ root: availableInstalledRoot, sourceBundles: [availableBundle.path] }), realScratch);
    await writeFile(destination, original);
    return result;
  }));

  rows.push(await runPositiveCase("stale-lock", async () => {
    if (bundle === undefined || installedRoot === undefined) return unavailableCase("stale-lock", "CONSUMER_ARTIFACT_UNAVAILABLE", { dependency: "consumer-install-clean-sync" });
    const availableBundle = bundle;
    const availableInstalledRoot = installedRoot;
    const lockPath = join(availableInstalledRoot, ".tfsb", "brand.lock.json");
    const original = await readFile(lockPath);
    await writeFile(lockPath, "[]\n", "utf8");
    const result = await runStateBoundRejection("stale-lock", availableInstalledRoot, { operation: "planConsumerSync", expected: "CONSUMER_LOCK_INVALID" }, ["CONSUMER_LOCK_INVALID", "CONSUMER_LOCK_INVALID_JSON"], async () => product.planConsumerSync({ root: availableInstalledRoot, sourceBundles: [availableBundle.path] }), realScratch);
    await writeFile(lockPath, original);
    return result;
  }));

  rows.push(await runPositiveCase("successful-apply", async () => {
    if (bundle === undefined) return unavailableCase("successful-apply", "CONSUMER_ARTIFACT_UNAVAILABLE", { dependency: "bundle-create-validate-import" });
    const consumerRoot = await createConsumerProject(realScratch, "successful-apply");
    const before = await snapshotTemporaryTree(consumerRoot);
    const plan = await product.planConsumerInstall({ root: consumerRoot, sourceBundles: [bundle.path], profiles: ["terminal-nova/astro-starlight"] });
    await product.executeConsumerInstallPlan(plan);
    const after = await snapshotTemporaryTree(consumerRoot);
    const state = await product.inspectConsumerState({ root: consumerRoot, sourceBundles: [bundle.path] });
    const lockBytes = await readFile(join(consumerRoot, ".tfsb", "brand.lock.json"));
    if (state.status !== "ok" || state.packages.length !== 1 || lockBytes.byteLength === 0) throw new Error("CORE_SUCCESSFUL_APPLY_NOT_OBSERVED");
    return passCase("successful-apply", "TRANSACTION_APPLY_COMMITTED", { state: state.status, packageCount: state.packages.length }, [artifactIdentity("tree-state", "successful-apply-before", before), planArtifact("successful-apply-plan", plan, realScratch), artifactIdentity("tree-state", "successful-apply-after", after), artifactIdentity("consumer-lock", "successful-apply-brand.lock.json", lockBytes)]);
  }));

  rows.push(await runPositiveCase("failed-apply-exact-rollback", async () => {
    if (bundle === undefined) return unavailableCase("failed-apply-exact-rollback", "BUNDLE_ARTIFACT_UNAVAILABLE", { dependency: "bundle-create-validate-import" });
    const consumerRoot = await createConsumerProject(realScratch, "failed-apply-rollback");
    const before = await snapshotTemporaryTree(consumerRoot);
    const plan = await product.planConsumerInstall({ root: consumerRoot, sourceBundles: [bundle.path], profiles: ["terminal-nova/astro-starlight"] });
    const result = await runExpectedFailureCase("failed-apply-exact-rollback", ["CONSUMER_TRANSACTION_ROLLED_BACK"], async () => product.executeConsumerInstallPlan(plan, { beforeLockPromotion: () => { throw new Error("controlled promotion failure"); } }));
    const after = await snapshotTemporaryTree(consumerRoot);
    if (result.status !== "pass" || Buffer.compare(before, after) !== 0) throw new Error("CORE_ROLLBACK_BYTES_DIFFER");
    return createCaseRow({ ...result, observations: { ...result.observations, exactRollback: true }, artifacts: [artifactIdentity("tree-state", "failed-apply-before", before), planArtifact("failed-apply-plan", plan, realScratch), artifactIdentity("tree-state", "failed-apply-rollback", after)] });
  }));

  rows.push(await runPositiveCase("raster-export-fixed-capability", async () => {
    const capability = await loadFixedRasterCapability();
    if (!capability.available) return unavailableCase("raster-export-fixed-capability", "RASTER_CAPABILITY_UNAVAILABLE", { reason: capability.reason });
    const projectRoot = await copyGeneratedProject(realScratch, "raster-export", corpus.assetMap, corpus.readmeBytes);
    const plan = await product.planRasterExport(projectRoot, { profileId: "web-icons", capability });
    const result = await product.executeRasterExportPlan(plan);
    if (result.writtenOutputs !== plan.outputs.length || result.writtenOutputs <= 0 || capability.adapter.descriptor.adapterId !== "resvg-png-v1") throw new Error("CORE_RASTER_EXPORT_NOT_EXECUTED");
    const outputPath = plan.outputs[0]?.destination;
    if (typeof outputPath !== "string") throw new Error("CORE_RASTER_OUTPUT_MISSING");
    return passCase("raster-export-fixed-capability", "FIXED_RASTER_CAPABILITY_EXECUTED", { adapterId: capability.adapter.descriptor.adapterId, rendererVersion: capability.adapter.descriptor.rendererVersion, plannedOutputs: plan.outputs.length, writtenOutputs: result.writtenOutputs }, [await fileArtifact(projectRoot, outputPath, "raster-output", "first-raster-output.png")]);
  }));

  rows.push(await runPositiveCase("two-run-byte-determinism", async () => {
    const producer = await copyGeneratedProject(realScratch, "determinism-one", corpus.assetMap, corpus.readmeBytes);
    const second = await copyGeneratedProject(realScratch, "determinism-two", corpus.assetMap, corpus.readmeBytes);
    const firstPlan = await product.planBrandBundle({ root: producer, output: "deterministic.zip" });
    await product.executeBrandBundle(firstPlan);
    const secondPlan = await product.planBrandBundle({ root: second, output: "deterministic.zip" });
    await product.executeBrandBundle(secondPlan);
    const firstBytes = await readFile(join(producer, "deterministic.zip"));
    const secondBytes = await readFile(join(second, "deterministic.zip"));
    if (Buffer.compare(firstBytes, secondBytes) !== 0) throw new Error("CORE_BUNDLE_DETERMINISM_FAILED");
    return passCase("two-run-byte-determinism", "TWO_BUNDLE_RUNS_BYTE_IDENTICAL", { byteLength: firstBytes.byteLength, digest: sha256Digest(firstBytes) }, [artifactIdentity("bundle", "determinism-run-one.zip", firstBytes), artifactIdentity("bundle", "determinism-run-two.zip", secondBytes)]);
  }));

  return finalizeCoreMatrix({ commit: corpus.commit, tree: corpus.tree, clean: corpus.clean, readmeDigest: corpus.readmeDigest, assetCount: Object.keys(corpus.assetMap).length }, rows, methods, ["brand.derive.plan", "brand.consumer.install.plan", "brand.consumer.sync.plan", "brand.export.plan"]);
}
