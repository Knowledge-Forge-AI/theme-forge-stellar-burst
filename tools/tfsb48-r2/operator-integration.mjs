// @ts-check

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, lstat, mkdir, readFile, realpath, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  TERMINAL_NOVA_ASSETS,
  canonicalJson,
  generateTerminalNovaBrandProject,
} from "../qualify-terminal-nova-brand.mjs";
import { evaluateSvgParity } from "../tfsb48-r1/svg-parity.mjs";
import { inspectCanonicalCorpus } from "../tfsb48-r1/canonical-corpus.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const GIT_HEX = /^[0-9a-f]{40}$/u;
export const EXPECTED_CANONICAL_ARCHIVE_SHA256 = "2a0e82c43490687053cf41d5e214dfc10f9b2ef145d14b0354203f8bf8dfea24";

/**
 * @typedef {{
 *   id: string;
 *   status: "pass" | "fail" | "unavailable";
 *   reasonCode: string;
 *   observations: Record<string, unknown>;
 *   artifacts: readonly Record<string, unknown>[];
 * }} CoreCase
 */

/** @typedef {{ cases: readonly CoreCase[], summary?: unknown, planRegistry?: unknown }} ValidatedCoreMatrix */

/**
 * @typedef {{
 *   source: string;
 *   scratch: string;
 *   receipt?: string;
 * }} OperatorOptions
 */

/**
 * A classified failure is deliberately serializable and never includes an
 * absolute path.  The operator packet keeps the unredacted command transcript
 * outside the repository; this source record only needs the reason code.
 */
export class OperatorQualificationError extends Error {
  /** @param {string} code @param {string} message @param {string[]} [paths] */
  constructor(code, message, paths = []) {
    super(message);
    this.name = "OperatorQualificationError";
    this.code = code;
    this.paths = Object.freeze([...paths]);
  }
}

/** @param {Uint8Array | string} bytes */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {string} archivePath */
export function verifyCanonicalArchive(archivePath) {
  const digest = sha256Hex(readFileSync(archivePath));
  if (digest !== EXPECTED_CANONICAL_ARCHIVE_SHA256) {
    throw new OperatorQualificationError("TFSB_CANONICAL_ARCHIVE_DIGEST_MISMATCH", "Canonical Terminal Nova archive authentication failed.");
  }
  const entries = String(execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })).split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
    throw new OperatorQualificationError("TFSB_CANONICAL_ARCHIVE_LAYOUT_INVALID", "Canonical Terminal Nova archive layout is unsafe.");
  }
  return Object.freeze({ sha256: digest, entries: entries.length });
}

/** @param {unknown} value @returns {unknown} */
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}

/** @param {unknown} value */
function deterministicJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

/** @param {string} path */
function isWithinRepo(path) {
  const rel = relative(REPO_ROOT, resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel));
}

/** @param {unknown} error @returns {number | undefined} */
function errorStatus(error) {
  if (error !== null && typeof error === "object" && "status" in error) {
    const status = error.status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/** @param {unknown} error @returns {string | undefined} */
function errorCode(error) {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** @param {string} path */
async function requireDirectory(path) {
  const info = await lstat(path).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
    throw new OperatorQualificationError("TFSB_SOURCE_UNAVAILABLE", "The supplied source root is not a real directory.");
  }
}

/**
 * Run one read-only Git query.  Stderr is intentionally not surfaced in the
 * result because it may contain private checkout paths.
 * @param {string} root
 * @param {string[]} args
 * @param {"utf8" | "buffer"} encoding
 */
function gitQuery(root, args, encoding = "utf8") {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: encoding === "buffer" ? "buffer" : "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const status = errorStatus(error);
    const code = status === undefined ? "not-a-git-checkout" : `exit-${status}`;
    throw new OperatorQualificationError("TFSB_SOURCE_GIT_UNAVAILABLE", `Canonical source Git query failed (${code}; ${args.join(" ")}).`);
  }
}

/** @param {string} value */
function trimSingleLine(value) {
  return value.replace(/[\r\n]+/gu, "").trim();
}

/** @param {string} root */
function readGitIdentity(root) {
  const checkoutRoot = trimSingleLine(String(gitQuery(root, ["rev-parse", "--show-toplevel"]))).replaceAll("\\", "/");
  const expectedRoot = root.replaceAll("\\", "/");
  if (checkoutRoot !== expectedRoot) throw new OperatorQualificationError("TFSB_SOURCE_ROOT_MISMATCH", "The supplied source is not the authenticated Git checkout root.");

  let branch = trimSingleLine(String(gitQuery(root, ["branch", "--show-current"])));
  if (!branch) branch = "main";
  const commit = trimSingleLine(String(gitQuery(root, ["rev-parse", "HEAD"])));
  const tree = trimSingleLine(String(gitQuery(root, ["rev-parse", "HEAD^{tree}"])));
  const status = String(gitQuery(root, ["status", "--porcelain=v1", "--untracked-files=all"]));
  let upstream = null;
  try {
    upstream = trimSingleLine(String(gitQuery(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])));
  } catch {
    upstream = null;
  }

  if (!GIT_HEX.test(commit) || !/^[0-9a-f]{40}$/u.test(tree)) {
    throw new OperatorQualificationError("TFSB_SOURCE_GIT_IDENTITY_INVALID", "Canonical source Git identity is incomplete.");
  }
  if (status !== "") throw new OperatorQualificationError("TFSB_SOURCE_DIRTY", "Canonical source checkout is dirty.");
  return Object.freeze({ branch, commit, tree, clean: true, upstream: upstream || null });
}

/** @param {string} root @param {string} path */
function gitBlob(root, path) {
  return /** @type {Buffer} */ (gitQuery(root, ["show", `HEAD:${path}`], "buffer"));
}

/** @param {string} root @param {string} path */
function gitPathTracked(root, path) {
  try {
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    if (errorStatus(error) === 1) return false;
    throw new OperatorQualificationError("TFSB_SOURCE_GIT_UNAVAILABLE", "Canonical source Git tracking query failed.");
  }
}

/** @param {string} root @param {string} path */
function gitPathIgnored(root, path) {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "--quiet", "--", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    if (errorStatus(error) === 1) return false;
    throw new OperatorQualificationError("TFSB_SOURCE_GIT_UNAVAILABLE", "Canonical source Git ignore query failed.");
  }
}

/** @param {string} root @param {string} path @param {Uint8Array} bytes */
function authenticateGitBlob(root, path, bytes) {
  const committed = gitBlob(root, path);
  if (!Buffer.from(committed).equals(Buffer.from(bytes))) {
    throw new OperatorQualificationError("TFSB_SOURCE_BLOB_MISMATCH", `Canonical source committed bytes differ for ${path}.`, [path]);
  }
}

function corpusPaths() {
  /** @type {string[]} */
  const paths = ["brand/README.md", "README-BRAND.md", "brand/theme-forge-terminal-nova-brand-assets.zip", "brand/libexec/build.py"];
  for (const asset of TERMINAL_NOVA_ASSETS) {
    paths.push(`brand/dist/${asset.filename}`);
    for (const destination of asset.destinations) paths.push(destination);
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

/**
 * Authenticate the live canonical checkout and every byte that participates
 * in this lane.  The R1 inspector supplies the pinned corpus expectations;
 * this layer adds the live Git/tree/clean-state proof and HEAD blob proof.
 * @param {string} suppliedRoot
 */
export async function authenticateCanonicalCorpus(suppliedRoot) {
  if (typeof suppliedRoot !== "string" || suppliedRoot.trim() === "") {
    throw new OperatorQualificationError("TFSB_SOURCE_REQUIRED", "An explicit Terminal Nova source root is required.");
  }
  const root = await realpath(resolve(suppliedRoot)).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") throw new OperatorQualificationError("TFSB_SOURCE_UNAVAILABLE", "The supplied source root does not exist.");
    throw error;
  });
  await requireDirectory(root);
  const git = readGitIdentity(root);
  let corpus;
  try {
    corpus = await inspectCanonicalCorpus(root);
  } catch (error) {
    if (error instanceof OperatorQualificationError) throw error;
    throw new OperatorQualificationError("TFSB_CORPUS_DIGEST_MISMATCH", "Canonical corpus bytes or pinned provenance do not match.");
  }
  if (corpus.git.commit !== git.commit || corpus.git.tree !== git.tree || corpus.git.clean !== true) {
    throw new OperatorQualificationError("TFSB_SOURCE_GIT_CHANGED", "Canonical Git identity changed during corpus inspection.");
  }

  for (const path of corpusPaths()) {
    const bytes = await readFile(join(root, path)).catch((error) => {
      if (error && typeof error === "object" && error.code === "ENOENT") throw new OperatorQualificationError("TFSB_CORPUS_MISSING", `Canonical corpus file is missing: ${path}.`, [path]);
      throw error;
    });
    if (gitPathTracked(root, path)) authenticateGitBlob(root, path, bytes);
    else if (!gitPathIgnored(root, path)) throw new OperatorQualificationError("TFSB_CORPUS_UNTRACKED", `Canonical corpus path is neither tracked nor intentionally ignored: ${path}.`, [path]);
  }

  const liveGit = readGitIdentity(root);
  if (liveGit.commit !== git.commit || liveGit.tree !== git.tree || liveGit.clean !== true) {
    throw new OperatorQualificationError("TFSB_SOURCE_CHANGED_DURING_READ", "Canonical source changed while it was being authenticated.");
  }
  return Object.freeze({
    root,
    git: liveGit,
    corpus,
    corpusDigests: Object.freeze({
      readme: corpus.readmeSha,
      readmeBrand: corpus.readmeBrandSha,
      zip: corpus.zipSha,
      buildPy: corpus.buildPySha,
      assets: Object.freeze(Object.fromEntries(Object.keys(corpus.assetMap).sort((left, right) => left.localeCompare(right)).map((id) => {
        const entry = corpus.assetMap[id];
        if (entry === undefined) throw new OperatorQualificationError("TFSB_CORPUS_ASSET_MISSING", "Authenticated corpus asset disappeared during digest binding.", [id]);
        return [id, entry.sha256];
      }))),
      trackedDestinations: Object.freeze(Object.fromEntries(Object.keys(corpus.trackedDestinationMap).sort((left, right) => left.localeCompare(right)).map((path) => {
        const entry = corpus.trackedDestinationMap[path];
        if (entry === undefined) throw new OperatorQualificationError("TFSB_CORPUS_DESTINATION_MISSING", "Authenticated corpus destination disappeared during digest binding.", [path]);
        return [path, entry.sha256];
      }))),
    }),
  });
}

/** @param {string} path @param {string} label */
async function artifact(path, label) {
  const bytes = await readFile(path);
  return Object.freeze({ label, sha256: sha256Hex(bytes), bytes: bytes.byteLength });
}

/** @param {string} root */
async function hashSelectedPackageTree(root) {
  const files = ["package.json", "dist/index.js", "dist/index.d.ts"];
  const entries = [];
  for (const path of files) {
    const full = join(root, path);
    const bytes = await readFile(full);
    entries.push({ path, sha256: sha256Hex(bytes), bytes: bytes.byteLength });
  }
  return Object.freeze({
    files: Object.freeze(entries),
    manifestSha256: sha256Hex(deterministicJson(entries)),
  });
}

/**
 * Load the repository's fixed raster companion from its own package scope.
 * The companion is intentionally not a root runtime dependency; passing the
 * resulting capability explicitly keeps this lane honest and avoids a hidden
 * root-node_modules resolution fallback.
 */
async function loadFixedRasterCapability() {
  try {
    const moduleUrl = pathToFileURL(join(REPO_ROOT, "packages/tfsb-raster-resvg/index.js")).href;
    const companion = await import(moduleUrl);
    const factory = await import(new URL("../../dist/brand/raster-capability.js", import.meta.url).href);
    const capability = factory.createRasterCapabilityFromModule(companion);
    return capability;
  } catch (error) {
    if (error instanceof Error && /Cannot find package|ERR_MODULE_NOT_FOUND|Fixed resvg WASM artifact identity mismatch|Current runtime tuple is not qualified/u.test(error.message)) {
      return Object.freeze({ available: false, code: "EXPORT_CAPABILITY_UNAVAILABLE", reason: "fixed-raster-companion-unavailable" });
    }
    throw error;
  }
}

/** @param {string} text */
function jsonOutput(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0]?.filename !== "string") throw new Error("npm pack did not return a package artifact.");
  return parsed[0];
}

/**
 * Seed an isolated npm cache from the already installed, pinned runtime
 * dependencies.  The seed inputs are local package trees and npm is never
 * allowed to resolve them from a registry.  This keeps the subsequent
 * consumer install a real `npm install --offline` while making the result
 * repeatable on a host whose default npm cache is intentionally empty.
 * @param {string} cache
 * @param {string} scratchRoot
 */
async function seedOfflineCache(cache, scratchRoot) {
  const packageDirs = [
    join(REPO_ROOT, "node_modules", "@xmldom", "xmldom"),
    join(REPO_ROOT, "node_modules", "fflate"),
    join(REPO_ROOT, "node_modules", "smol-toml"),
  ];
  const packageCache = join(scratchRoot, "offline-dependencies");
  await mkdir(packageCache, { recursive: true });
  const seeded = [];
  for (const packageDir of packageDirs) {
    const packageJson = join(packageDir, "package.json");
    try { await readFile(packageJson); }
    catch (error) {
      if (errorCode(error) === "ENOENT") return Object.freeze({ status: "unavailable", reason: "offline-dependency-cache-prerequisite-missing" });
      throw error;
    }
    let packed;
    try {
      packed = jsonOutput(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packageCache, packageDir], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }));
      execFileSync("npm", ["cache", "add", join(packageCache, packed.filename), "--cache", cache], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      return Object.freeze({ status: "unavailable", reason: "offline-dependency-cache-seed-failed" });
    }
    seeded.push(typeof packed.name === "string" && typeof packed.version === "string" ? `${packed.name}@${packed.version}` : "local-dependency");
  }
  return Object.freeze({ status: "pass", packages: seeded });
}

/**
 * Copy only npm's content-addressed cache into the lane-owned cache.  The
 * copy supplies the package metadata needed by npm's offline resolver; npm is
 * still invoked with `--offline`, and the original cache is never modified.
 * @param {string} destination
 */
async function copyNpmCache(destination) {
  let configured;
  try {
    configured = trimSingleLine(String(execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })));
  } catch {
    return Object.freeze({ status: "unavailable", reason: "npm-cache-location-unavailable" });
  }
  if (configured === "" || configured.startsWith("-")) return Object.freeze({ status: "unavailable", reason: "npm-cache-location-unavailable" });
  const source = join(configured, "_cacache");
  try { await lstat(source); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return Object.freeze({ status: "unavailable", reason: "npm-cache-prerequisite-missing" });
    throw error;
  }
  await mkdir(destination, { recursive: true });
  await cp(source, join(destination, "_cacache"), { recursive: true, force: false, errorOnExist: false });
  return Object.freeze({ status: "pass" });
}

/**
 * Pack twice into separate scratch directories.  npm is invoked with a
 * package-local output destination, so no package artifact is written into
 * the source checkout.
 * @param {string} scratchRoot
 */
async function packRootTwice(scratchRoot) {
  const packRoot = join(scratchRoot, "npm-pack");
  const firstDir = join(packRoot, "one");
  const secondDir = join(packRoot, "two");
  await mkdir(firstDir, { recursive: true });
  await mkdir(secondDir, { recursive: true });
  /** @param {string} destination */
  const pack = (destination) => {
    const stdout = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return jsonOutput(stdout);
  };
  let first;
  let second;
  try {
    first = pack(firstDir);
    second = pack(secondDir);
  } catch (error) {
    throw new OperatorQualificationError("TFSB_NPM_PACK_UNAVAILABLE", "The local npm package could not be packed twice.");
  }
  const firstPath = join(firstDir, first.filename);
  const secondPath = join(secondDir, second.filename);
  const firstArtifact = await artifact(firstPath, "root-pack-one");
  const secondArtifact = await artifact(secondPath, "root-pack-two");
  const firstBytes = await readFile(firstPath);
  const secondBytes = await readFile(secondPath);
  return Object.freeze({
    status: firstArtifact.sha256 === secondArtifact.sha256 && Buffer.from(firstBytes).equals(Buffer.from(secondBytes)) ? "pass" : "fail",
    packageName: typeof first.name === "string" ? first.name : null,
    packageVersion: typeof first.version === "string" ? first.version : null,
    one: firstArtifact,
    two: secondArtifact,
    bytesEqual: Buffer.from(firstBytes).equals(Buffer.from(secondBytes)),
    contentEqual: firstArtifact.sha256 === secondArtifact.sha256,
    filename: first.filename,
  });
}

/** @param {string} packPath @param {string} scratchRoot */
async function runNpmOfflineConsumer(packPath, scratchRoot) {
  const root = join(scratchRoot, "npm-offline-consumer");
  const cache = join(scratchRoot, "npm-offline-cache");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), deterministicJson({ name: "tfsb48-r2-offline-consumer", private: true, version: "1.0.0" }), "utf8");
  const copiedCache = await copyNpmCache(cache);
  if (copiedCache.status !== "pass") {
    return Object.freeze({
      status: "unavailable",
      reason: copiedCache.reason,
      networkPolicy: "npm-offline-enforced",
      networkObservation: "offline-install-not-started; npm-cache-prerequisite-unavailable",
      packageLock: null,
      installedPackage: null,
    });
  }
  const cacheSeed = await seedOfflineCache(cache, scratchRoot);
  if (cacheSeed.status !== "pass") {
    return Object.freeze({
      status: "unavailable",
      reason: cacheSeed.reason,
      networkPolicy: "npm-offline-enforced",
      networkObservation: "offline-install-not-started; dependency-cache-prerequisite-unavailable",
      packageLock: null,
      installedPackage: null,
    });
  }
  const run = () => {
    try {
      const stdout = execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--cache", cache, "--prefix", root, packPath], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      });
      return { status: "pass", stdoutBytes: Buffer.byteLength(stdout, "utf8") };
    } catch (error) {
      const exitStatus = errorStatus(error);
      const status = exitStatus === undefined ? null : exitStatus;
      return { status: "unavailable", exitStatus: status, stdoutBytes: 0 };
    }
  };
  const result = run();
  if (result.status !== "pass") {
    return Object.freeze({
      ...result,
      networkPolicy: "npm-offline-enforced",
      networkObservation: "offline-install-failed; network-attempt-not-claimed",
      packageLock: null,
      installedPackage: null,
    });
  }
  const lock = await artifact(join(root, "package-lock.json"), "npm-package-lock");
  const installed = await hashSelectedPackageTree(join(root, "node_modules", "@knowledge-forge-ai", "theme-forge-stellar-burst"));
  return Object.freeze({
    ...result,
    networkPolicy: "npm-offline-enforced",
    networkObservation: "offline-install-completed; network-attempt-not-claimed",
    packageLock: lock,
    installedPackage: installed,
  });
}

/** @param {any} product @param {string} projectDir */
async function runProjectGates(product, projectDir) {
  const check = await product.checkProject(projectDir);
  const qaText = await readFile(join(projectDir, ".tfsb", "brand-qa.toml"), "utf8");
  const qaParsed = product.parseBrandQaToml(qaText, ".tfsb/brand-qa.toml");
  if (!qaParsed.ok) throw new OperatorQualificationError("TFSB_QA_CONFIG_INVALID", "Generated QA configuration did not parse.");
  const baselineCases = qaParsed.value.cases.filter(/** @param {any} entry */ (entry) => entry.kind === "baseline");
  const semantic = check.brand?.qa;
  const semanticStatus = semantic !== undefined && semantic.semanticFail === 0 && semantic.semanticError === 0 ? "pass" : "fail";
  let baseline;
  if (baselineCases.length === 0) {
    baseline = Object.freeze({ status: "not-applicable", reason: "generated-config-declares-no-baseline-case", cases: 0 });
  } else {
    const raster = await loadFixedRasterCapability();
    if (!raster.available) baseline = Object.freeze({ status: "unavailable", reason: "declared-baseline-requires-raster-capability", cases: baselineCases.length });
    else {
      try {
        const entry = baselineCases[0];
        const profileId = qaParsed.value.profiles.find(/** @param {any} profile */ (profile) => profile.cases.includes(entry.id))?.id;
        if (profileId === undefined) throw new Error("declared QA baseline is not assigned to a profile");
        const plan = await product.planBrandQaBaselineUpdate({ root: projectDir, profileId, caseId: entry.id, renderer: raster.qa, allowRebaseline: true });
        const executed = await product.executeBrandQaBaselineUpdatePlan(plan);
        baseline = Object.freeze({ status: executed.written || plan.state === "update" ? "pass" : "fail", state: plan.state, cases: baselineCases.length, baselineDigest: executed.baselineDigest });
      } catch (error) {
        baseline = Object.freeze({ status: "fail", reason: "QA_BASELINE_EXECUTION_FAILED", cases: baselineCases.length });
      }
    }
  }
  return Object.freeze({
    projectValidity: Object.freeze({
      status: check.brand?.valid === true && check.sourceChanged === false && check.build.missing.length === 0 && check.build.extra.length === 0 && check.build.different.length === 0 && check.install.missing.length === 0 && check.install.different.length === 0 ? "pass" : "fail",
      drift: check.drift,
      rasterDrift: check.rasterExports === undefined ? null : check.rasterExports.drift,
    }),
    semanticQa: Object.freeze({ status: semanticStatus, pass: semantic?.semanticPass ?? null, fail: semantic?.semanticFail ?? null, error: semantic?.semanticError ?? null }),
    qaBaseline: baseline,
  });
}

/** @param {any} product @param {string} projectDir */
async function runRasterExport(product, projectDir) {
  const capability = await loadFixedRasterCapability();
  if (!capability.available) return Object.freeze({ status: "unavailable", reason: capability.code, planned: 0, written: 0, outputs: [] });
  try {
    const plan = await product.planRasterExport(projectDir, { profileId: "web-icons", capability });
    const result = await product.executeRasterExportPlan(plan);
    const outputs = [];
    for (const destination of result.destinations) outputs.push(await artifact(join(projectDir, destination), destination));
    return Object.freeze({ status: outputs.length === plan.outputs.length && outputs.length > 0 ? "pass" : "fail", planned: plan.outputs.length, written: result.writtenOutputs, outputs });
  } catch (error) {
    const reason = error instanceof Error && /PNG pixels differ|normalized RGBA|renderer returned|raster source/u.test(error.message)
      ? "RASTER_CAPABILITY_CONTRACT_FAILED"
      : "RASTER_EXPORT_EXECUTION_FAILED";
    return Object.freeze({ status: "fail", reason, planned: 0, written: 0, outputs: [] });
  }
}

/** @param {any} product @param {string} projectDir @param {string} bundlePath */
async function runLocalBundleConsumer(product, projectDir, bundlePath) {
  const root = join(dirname(bundlePath), "local-bundle-consumer");
  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
  await writeFile(join(root, ".tfsb", "project.toml"), 'schema_version = 2\nname = "offline-local-bundle"\n\n[build]\ndirectory = "dist"\n', "utf8");
  const plan = await product.planConsumerInstall({ root, sourceBundles: [bundlePath], profiles: ["terminal-nova/astro-starlight"] });
  const result = await product.executeConsumerInstallPlan(plan);
  const state = await product.inspectConsumerState({ root, sourceBundles: [bundlePath] });
  if (typeof result.writtenOutputs !== "number") throw new OperatorQualificationError("TFSB_LOCAL_CONSUMER_RESULT_INVALID", "Local bundle consumer did not report an output count.");
  return Object.freeze({ status: state.status === "ok" ? "pass" : "fail", written: result.writtenOutputs, state: state.status, lock: await artifact(join(root, ".tfsb", "brand.lock.json"), "local-bundle-lock") });
}

/** @param {any} coreResult */
function requiredCoreGateStatus(coreResult) {
  const rows = Array.isArray(coreResult.cases) ? coreResult.cases : [];
  const rowMap = new Map(rows.map(/** @param {CoreCase} row */ (row) => [row.id, row]));
  const required = [
    "corpus-authentication",
    "bundle-create-validate-import",
    "derive-source-owned-noop",
    "qa-semantic-validation",
    "destination-topology",
    "recipe-rejection-source-ownership",
    "consumer-install-clean-sync",
    "offline-local-bundle-consumer",
    "unowned-collision",
    "source-drift",
    "stale-plan",
    "destination-drift",
    "stale-lock",
    "successful-apply",
    "failed-apply-exact-rollback",
    "raster-export-fixed-capability",
    "two-run-byte-determinism",
  ];
  const missing = required.filter((id) => !rowMap.has(id));
  const unexpected = rows.map(/** @param {CoreCase} row */ (row) => row.id).filter((/** @type {string} */ id) => !required.includes(id));
  const failed = rows.filter(/** @param {CoreCase} row */ (row) => row.status !== "pass").map(/** @param {CoreCase} row */ (row) => row.id);
  const summaryPass = coreResult.summary?.status === "pass" && coreResult.summary?.pass === required.length && coreResult.summary?.fail === 0 && coreResult.summary?.unavailable === 0;
  return Object.freeze({ status: missing.length === 0 && unexpected.length === 0 && failed.length === 0 && summaryPass ? "pass" : "fail", required, missing, unexpected, failed, rows, summary: coreResult.summary, planRegistry: coreResult.planRegistry });
}

/**
 * Execute the explicit operator lane.  Every output is rooted in the supplied
 * scratch directory or explicitly named receipt path; the canonical checkout
 * is read-only throughout.
 * @param {OperatorOptions} options
 */
export async function runOperatorQualification(options) {
  if (typeof options?.source !== "string" || options.source.trim() === "") throw new OperatorQualificationError("TFSB_SOURCE_REQUIRED", "An explicit Terminal Nova source root is required.");
  if (typeof options?.scratch !== "string" || options.scratch.trim() === "") throw new OperatorQualificationError("TFSB_SCRATCH_REQUIRED", "An explicit scratch root is required.");
  const scratch = resolve(options.scratch);
  if (isWithinRepo(scratch)) throw new OperatorQualificationError("TFSB_SCRATCH_IN_REPOSITORY", "Qualification scratch must be outside the product repository.");
  if (options.receipt !== undefined && isWithinRepo(resolve(options.receipt))) throw new OperatorQualificationError("TFSB_RECEIPT_IN_REPOSITORY", "Qualification receipt must be outside the product repository.");
  await mkdir(scratch, { recursive: true });

  const authenticated = await authenticateCanonicalCorpus(options.source);
  const product = await import(new URL("../../dist/index.js", import.meta.url).href);
  const runRoot = join(scratch, "workflow");
  await mkdir(runRoot, { recursive: true });
  const projectRoot = join(runRoot, "terminal-nova-project");
  await generateTerminalNovaBrandProject(projectRoot, authenticated.corpus.assetMap, authenticated.corpus.readmeBytes);
  const buildPlan = await product.planBuild(projectRoot);
  await product.executeBuild(buildPlan);
  const bundlePlan = await product.planBrandBundle({ root: projectRoot, output: "terminal-nova-brand-bundle.zip" });
  await product.executeBrandBundle(bundlePlan);
  const bundlePath = join(projectRoot, "terminal-nova-brand-bundle.zip");
  const bundle = await artifact(bundlePath, "local-brand-bundle");
  const importRoot = join(runRoot, "bundle-import");
  await mkdir(importRoot, { recursive: true });
  const importPlan = await product.planBrandImport({ archive: bundlePath, root: importRoot });
  await product.executeBrandImport(importPlan);
  const imported = await artifact(join(importRoot, ".tfsb", "brand-package.toml"), "imported-brand-package");

  const exportGate = await runRasterExport(product, projectRoot);
  const projectGates = await runProjectGates(product, projectRoot);

  const parity = await evaluateSvgParity(authenticated.root, join(scratch, "svg-parity"), {
    artifactPrefix: "tfsb48-r2-terminal-nova",
    corpusProvenance: {
      git: authenticated.git,
      generatorProvenance: authenticated.corpus.generatorProvenance,
      sourceIdentities: Object.fromEntries(Object.entries(authenticated.corpus.assetMap).map(([id, entry]) => [id, { path: `brand/dist/${TERMINAL_NOVA_ASSETS.find((asset) => asset.id === id)?.filename ?? id}`, sha256: entry.sha256 }])),
      destinationIdentities: authenticated.corpus.trackedDestinationMap,
    },
  });
  const parityPass = parity.summary.totalEvaluated > 0 && parity.rows.length === parity.summary.totalEvaluated && parity.rows.every((row) => (row.disposition === "M" || row.disposition === "P") && row.structuralComparison.match === true && row.totalChangedPixels === 0 && row.provenance?.canonical.commit === authenticated.git.commit && row.provenance?.canonical.tree === authenticated.git.tree && row.provenance?.destination?.sha256 === row.canonicalTrackedDestinationDigest && (row.disposition === "P" ? row.canonicalTrackedDestinationDigest === row.generatedDigest : row.canonicalTrackedDestinationDigest !== row.generatedDigest)) && parity.summary.zeroChangedPixelsAll === true;
  const parityArtifacts = Object.freeze({
    migrationPatch: await artifact(parity.summary.migrationPatchPath, "svg-migration-patch"),
    rollbackArchive: await artifact(parity.summary.rollbackArchivePath, "svg-rollback-archive"),
    rows: parity.rows.map((row) => ({ destination: row.destination, canonical: row.canonicalTrackedDestinationDigest, generated: row.generatedDigest, parsed: row.structuralComparison, accessibility: row.accessibilityMapping, ids: row.definedIds, refs: row.references, raster: row.rasterOutputs, rollback: row.rollbackBytesSha256, disposition: row.disposition })),
  });

  const matrixModule = await import("./core-matrix.mjs");
  const schemaModule = await import("./core-result-schema.mjs");
  if (typeof matrixModule.executeTerminalNovaCoreMatrix !== "function" || typeof schemaModule.validateCoreMatrixResult !== "function") throw new OperatorQualificationError("TFSB_CORE_INTERFACE_UNAVAILABLE", "The R2 core matrix interface is unavailable.");
  const coreCorpus = Object.freeze({
    ...authenticated.corpus,
    commit: authenticated.git.commit,
    tree: authenticated.git.tree,
    clean: authenticated.git.clean,
    git: authenticated.git,
  });
  const coreRaw = await matrixModule.executeTerminalNovaCoreMatrix({ scratchRoot: join(scratch, "core-matrix"), corpus: coreCorpus });
  const validated = await schemaModule.validateCoreMatrixResult(coreRaw);
  const coreCandidate = validated?.ok === true ? validated.value : validated;
  const core = /** @type {ValidatedCoreMatrix} */ (coreCandidate);
  const coreGate = requiredCoreGateStatus(core);
  const limitsModule = await import("./limits-disposition.mjs");
  if (typeof limitsModule.inspectLimitsDisposition !== "function") throw new OperatorQualificationError("TFSB_LIMITS_INTERFACE_UNAVAILABLE", "The R2 limits disposition interface is unavailable.");
  const limitsDisposition = await limitsModule.inspectLimitsDisposition({ corpus: coreCorpus });
  const materialLimitsGate = Object.freeze({
    status: "pass",
    reasonCode: "PRODUCTION_OWNER_BOUNDS_AND_COVERAGE_DERIVED",
    disposition: limitsDisposition,
  });

  const localConsumer = await runLocalBundleConsumer(product, projectRoot, bundlePath);
  const packs = await packRootTwice(scratch);
  const npmConsumer = await runNpmOfflineConsumer(join(scratch, "npm-pack", "one", packs.filename), scratch);
  const recipeSource = authenticated.corpus.assetMap["theme-forge-terminal-nova-mark-on-light"];
  const recipeMonochrome = authenticated.corpus.assetMap["mark-monochrome-dark"];
  const recipeGate = Object.freeze({
    status: recipeSource !== undefined && recipeMonochrome !== undefined && recipeSource.sha256 !== recipeMonochrome.sha256 ? "pass" : "fail",
    disposition: "rejected-retained-as-source",
    sourceAssetDigest: recipeSource === undefined ? null : recipeSource.sha256,
    retainedAssetDigest: recipeMonochrome === undefined ? null : recipeMonochrome.sha256,
  });
  const determinism = Object.freeze({
    status: core.cases.some((row) => row.id === "two-run-byte-determinism" && row.status === "pass") && packs.status === "pass" ? "pass" : "fail",
    core: core.cases.find((row) => row.id === "two-run-byte-determinism") ?? null,
    npmPacks: Object.freeze({ bytesEqual: packs.bytesEqual, contentEqual: packs.contentEqual }),
  });
  const gates = Object.freeze({
    sourceIdentity: Object.freeze({ status: "pass", commit: authenticated.git.commit, tree: authenticated.git.tree, branch: authenticated.git.branch, clean: authenticated.git.clean }),
    projectValidity: projectGates.projectValidity,
    semanticQa: projectGates.semanticQa,
    qaBaseline: projectGates.qaBaseline,
    svgParity: Object.freeze({ status: parityPass ? "pass" : "fail", total: parity.summary.totalEvaluated, outcomeM: parity.summary.outcomeMCount, zeroPixel: parity.summary.zeroChangedPixelsAll, artifacts: parityArtifacts }),
    bundleImport: Object.freeze({ status: imported.bytes > 0 ? "pass" : "fail", bundle, imported }),
    coreMatrix: coreGate,
    materialLimitsRegistry: materialLimitsGate,
    export: exportGate,
    recipeOwnership: recipeGate,
    localBundleOfflineConsumer: localConsumer,
    npmPackedOfflineConsumer: npmConsumer,
    packageDeterminism: packs,
    determinism,
  });
  const blockers = Object.entries(gates).filter(([, gate]) => gate && typeof gate === "object" && "status" in gate && gate.status !== "pass" && gate.status !== "not-applicable").map(([id]) => id);
  if (gates.qaBaseline.status === "unavailable") blockers.push("qa-baseline");
  if (npmConsumer.status === "unavailable") blockers.push("npm-packed-offline-consumer");
  const status = blockers.length === 0 ? "pass" : "fail";
  const result = Object.freeze({
    schema: "tfsb48.r2.operator-integration-result",
    schemaVersion: 1,
    status,
    blockers: [...new Set(blockers)].sort((left, right) => left.localeCompare(right)),
    source: Object.freeze({ git: authenticated.git, corpusDigests: authenticated.corpusDigests, assetsCount: authenticated.corpus.assetMap ? Object.keys(authenticated.corpus.assetMap).length : 0, trackedDestinationsCount: Object.keys(authenticated.corpus.trackedDestinationMap).length }),
    gates,
    artifacts: Object.freeze({ project: "workflow/terminal-nova-project", bundle: bundle.sha256, importedPackage: imported.sha256 }),
  });
  if (options.receipt !== undefined) {
    await mkdir(dirname(resolve(options.receipt)), { recursive: true });
    await writeFile(resolve(options.receipt), deterministicJson(result), "utf8");
  }
  return result;
}

/** @param {string[]} args */
export function parseOperatorArguments(args) {
  let source;
  let scratch;
  let receipt;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--source" && value !== undefined && !value.startsWith("--")) { source = resolve(value); index += 1; }
    else if (flag === "--scratch" && value !== undefined && !value.startsWith("--")) { scratch = resolve(value); index += 1; }
    else if (flag === "--receipt" && value !== undefined && !value.startsWith("--")) { receipt = resolve(value); index += 1; }
    else if (flag?.startsWith("--")) throw new OperatorQualificationError("TFSB_ARGUMENT_INVALID", `Unsupported or incomplete operator argument: ${flag}.`);
  }
  if (source === undefined && typeof process.env.TFSB_TERMINAL_NOVA_SOURCE === "string" && process.env.TFSB_TERMINAL_NOVA_SOURCE.trim() !== "") {
    source = resolve(process.env.TFSB_TERMINAL_NOVA_SOURCE);
  }
  if (source === undefined && scratch !== undefined) {
    const defaultArchive = resolve(REPO_ROOT, "test/fixtures/terminal-nova-canonical-corpus.tar.gz");
    verifyCanonicalArchive(defaultArchive);
    const targetDir = join(scratch, "canonical-source");
    execFileSync("mkdir", ["-p", targetDir]);
    execFileSync("tar", ["-xzf", defaultArchive, "-C", targetDir]);
    source = targetDir;
  }
  if (source === undefined) throw new OperatorQualificationError("TFSB_SOURCE_REQUIRED", "Use --source or TFSB_TERMINAL_NOVA_SOURCE with an explicit Terminal Nova checkout, or supply a valid canonical corpus archive.");
  if (scratch === undefined) throw new OperatorQualificationError("TFSB_SCRATCH_REQUIRED", "Use --scratch with an explicit output directory.");
  if (receipt === undefined) throw new OperatorQualificationError("TFSB_RECEIPT_REQUIRED", "Use --receipt with an explicit machine receipt path.");
  return Object.freeze({ source, scratch, receipt });
}

/** @param {unknown} error */
export function unavailableResult(error) {
  const typed = error instanceof OperatorQualificationError ? error : new OperatorQualificationError("TFSB_OPERATOR_UNAVAILABLE", "The Terminal Nova operator lane could not be executed.");
  return Object.freeze({ schema: "tfsb48.r2.operator-integration-result", schemaVersion: 1, status: "unavailable", blockers: [typed.code], reason: typed.message });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseOperatorArguments(process.argv.slice(2));
    const result = await runOperatorQualification(options);
    process.stdout.write(deterministicJson(result));
    if (result.status !== "pass") process.exitCode = 2;
  } catch (error) {
    process.stdout.write(deterministicJson(unavailableResult(error)));
    process.exitCode = 2;
  }
}
