#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { zipSync } from "fflate";

/**
 * @typedef {{ id: "simple-icons" | "lucide" | "tabler-icons" | "thesvg", checkout: string, revision: string }} CorpusInput
 * @typedef {{ mode: string, sha: string, path: string, bytes: Uint8Array, text: string, classification: "directly_importable" | "importable_with_normalization" | "unsupported" | "unsafe", featureCodes: readonly string[] }} GitBlob
 * @typedef {{ name: string, entries: readonly GitBlob[], accessibilityAuthority: "title-only" | "consumer_labelled" | "none", selectionRationale: string, legalDisposition: string, lifecycle: boolean }} ShardDefinition
 * @typedef {{ corpora: readonly CorpusInput[], scratchRoot: string, aggregateOutput?: string }} QualificationOptions
 * @typedef {{ analyze(options: any): Promise<any>, buildProject(root: string): Promise<any>, bundleProject(options: any): Promise<any>, checkProject(root: string): Promise<any>, importProject(options: any): Promise<any>, listProject(root: string): Promise<any>, scanAnalyzeSvg(bytes: Uint8Array, source?: string, virtualPath?: string): any }} ProductApi
 */

const textDecoder = new TextDecoder();
const FIXED_ZIP_TIME = new Date("1980-01-02T00:00:00Z");
const LOCAL_ONLY = "Local-only tracked-blob evaluation; no redistribution permission is claimed.";

/**
 * @param {string} left
 * @param {string} right
 */
function compareText(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stableJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

/**
 * @param {Uint8Array | string} value
 * @returns {string}
 */
function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * @param {string} checkout
 * @param {readonly string[]} args
 * @param {BufferEncoding | "buffer"} [encoding]
 * @returns {string | Buffer}
 */
function git(checkout, args, encoding = "utf8") {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: encoding === "buffer" ? "buffer" : encoding,
    maxBuffer: 128 * 1024 * 1024,
  });
}

/**
 * @param {CorpusInput} input
 */
function repositoryState(input) {
  const head = String(git(input.checkout, ["rev-parse", "HEAD"])).trim();
  const origin = String(git(input.checkout, ["config", "--get", "remote.origin.url"])).trim();
  const status = String(git(input.checkout, ["status", "--porcelain=v1", "--untracked-files=all"]));
  return { head, origin, dirty: status.length > 0 };
}

/**
 * @param {string} record
 * @returns {{ mode: string, sha: string, path: string } | undefined}
 */
function parseTreeRecord(record) {
  const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(record);
  return match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined
    ? undefined
    : { mode: match[1], sha: match[2], path: match[3] };
}

/**
 * @param {string} checkout
 * @param {{ mode: string, sha: string, path: string }} record
 * @param {ProductApi} product
 * @returns {GitBlob}
 */
function analyzeBlob(checkout, record, product) {
  const bytes = new Uint8Array(/** @type {Buffer} */ (git(checkout, ["cat-file", "blob", record.sha], "buffer")));
  const text = textDecoder.decode(bytes);
  const scanned = product.scanAnalyzeSvg(bytes, record.path, record.path).file.profiles.commonV03;
  return {
    ...record,
    bytes,
    text,
    classification: scanned.classification,
    featureCodes: scanned.featureCodes,
  };
}

/**
 * @param {CorpusInput} input
 * @param {readonly string[]} pathspecs
 * @param {ProductApi} product
 * @returns {readonly GitBlob[]}
 */
function listSvgBlobs(input, pathspecs, product) {
  const output = /** @type {Buffer} */ (git(input.checkout, ["ls-tree", "-r", "-z", input.revision, "--", ...pathspecs], "buffer"));
  return output
    .toString("utf8")
    .split("\0")
    .filter((record) => record.length > 0)
    .map(parseTreeRecord)
    .filter((record) => record !== undefined)
    .filter((record) => (record.mode === "100644" || record.mode === "100755") && record.path.toLowerCase().endsWith(".svg"))
    .sort((left, right) => compareText(left.path, right.path))
    .map((record) => analyzeBlob(input.checkout, record, product));
}

/**
 * @param {string} path
 * @returns {string}
 */
function assetKey(path) {
  return basename(path, ".svg").normalize("NFC").toLowerCase().replace(/[ _]+/g, "-");
}

/**
 * @param {readonly GitBlob[]} entries
 * @param {number} count
 * @param {Set<string>} [excluded]
 * @returns {readonly GitBlob[]}
 */
function collisionFree(entries, count, excluded = new Set()) {
  const selected = [];
  const identities = new Set(excluded);
  for (const entry of entries) {
    const identity = assetKey(entry.path);
    if (identities.has(identity)) continue;
    identities.add(identity);
    selected.push(entry);
    if (selected.length === count) break;
  }
  if (selected.length !== count) throw new Error(`Only ${selected.length} collision-free SVGs were available; ${count} required.`);
  return selected;
}

/**
 * @param {readonly GitBlob[]} entries
 * @param {number} count
 * @param {readonly RegExp[]} patterns
 * @returns {readonly GitBlob[]}
 */
function coverThenFill(entries, count, patterns) {
  const eligible = entries.filter((entry) => entry.classification === "directly_importable" || entry.classification === "importable_with_normalization");
  const selected = [];
  const identities = new Set();
  for (const pattern of patterns) {
    const entry = eligible.find((candidate) => !identities.has(assetKey(candidate.path)) && pattern.test(candidate.text));
    if (entry !== undefined) {
      selected.push(entry);
      identities.add(assetKey(entry.path));
    }
  }
  return [...selected, ...collisionFree(eligible.filter((entry) => !identities.has(assetKey(entry.path))), count - selected.length, identities)];
}

/**
 * @param {CorpusInput} input
 * @param {ProductApi} product
 * @returns {readonly ShardDefinition[]}
 */
function simpleShards(input, product) {
  const eligible = listSvgBlobs(input, ["icons"], product)
    .filter((entry) => entry.classification === "importable_with_normalization")
    .filter((entry) => /<title(?:\s|>)/.test(entry.text) && /<path(?:\s|>)/.test(entry.text));
  const selected = collisionFree(eligible, 32);
  const base = {
    accessibilityAuthority: /** @type {const} */ ("title-only"),
    selectionRationale: "Deterministic title-only, path-geometry, collision-free tracked blobs.",
    legalDisposition: `${LOCAL_ONLY} The optional 128 shard is omitted pending per-icon review.`,
    lifecycle: true,
  };
  return [
    { name: "simple-icons-16", entries: selected.slice(0, 16), ...base },
    { name: "simple-icons-32", entries: selected, ...base },
  ];
}

/**
 * @param {CorpusInput} input
 * @param {ProductApi} product
 * @returns {readonly ShardDefinition[]}
 */
function lucideShards(input, product) {
  const selected = coverThenFill(listSvgBlobs(input, ["icons"], product), 128, [
    /currentColor/,
    /stroke="[^"]+"/,
    /<circle(?:\s|>)/,
    /<rect(?:\s|>)/,
    /<line(?:\s|>)/,
    /<polyline(?:\s|>)/,
    /<polygon(?:\s|>)/,
    /transform="[^"]*translate/,
    /transform="[^"]*rotate/,
    /transform="[^"]*scale/,
  ]);
  const base = {
    accessibilityAuthority: /** @type {const} */ ("consumer_labelled"),
    selectionRationale: "Deterministic collision-free tracked blobs covering presentation, common shapes, and available transforms before sorted fill.",
    legalDisposition: LOCAL_ONLY,
    lifecycle: true,
  };
  return [
    { name: "lucide-16", entries: selected.slice(0, 16), ...base },
    { name: "lucide-32", entries: selected.slice(0, 32), ...base },
    { name: "lucide-128", entries: selected, ...base },
  ];
}

/**
 * @param {CorpusInput} input
 * @param {ProductApi} product
 * @returns {readonly ShardDefinition[]}
 */
function tablerShards(input, product) {
  const patterns = [/currentColor/, /<circle(?:\s|>)/, /<rect(?:\s|>)/, /<line(?:\s|>)/, /<polyline(?:\s|>)/, /<polygon(?:\s|>)/, /<use(?:\s|>)/];
  const outlineAll = listSvgBlobs(input, ["icons/outline"], product);
  const filledAll = listSvgBlobs(input, ["icons/filled"], product);
  const outline = coverThenFill(outlineAll, 64, patterns);
  const outlineIds = new Set(outline.map((entry) => assetKey(entry.path)));
  const filledEligible = filledAll.filter((entry) => (entry.classification === "directly_importable" || entry.classification === "importable_with_normalization") && !outlineIds.has(assetKey(entry.path)));
  const filled = coverThenFill(filledEligible, 64, patterns);
  const base = {
    accessibilityAuthority: /** @type {const} */ ("consumer_labelled"),
    legalDisposition: LOCAL_ONLY,
    lifecycle: true,
  };
  return [
    { name: "tabler-outline-16", entries: outline.slice(0, 16), selectionRationale: "Deterministic outline tracked blobs with presentation and common-shape coverage.", ...base },
    { name: "tabler-outline-32", entries: outline.slice(0, 32), selectionRationale: "Deterministic outline tracked blobs with presentation and common-shape coverage.", ...base },
    { name: "tabler-filled-16", entries: filled.slice(0, 16), selectionRationale: "Deterministic filled tracked blobs with identities disjoint from the paired outline set.", ...base },
    { name: "tabler-filled-32", entries: filled.slice(0, 32), selectionRationale: "Deterministic filled tracked blobs with identities disjoint from the paired outline set.", ...base },
    { name: "tabler-paired-128", entries: [...outline, ...filled], selectionRationale: "Collision-free paired 64-outline and 64-filled tracked blobs; no path-derived or collection-derived identity.", ...base },
  ];
}

/**
 * @param {CorpusInput} input
 * @param {ProductApi} product
 * @returns {readonly ShardDefinition[]}
 */
function theSvgShards(input, product) {
  const all = listSvgBlobs(input, ["."], product);
  const buckets = /** @type {const} */ (["directly_importable", "importable_with_normalization", "unsupported", "unsafe"]);
  return buckets.map((classification) => ({
    name: `thesvg-${classification.replaceAll("_", "-")}-inventory`,
    entries: all.filter((entry) => entry.classification === classification).slice(0, 2),
    accessibilityAuthority: /** @type {const} */ ("none"),
    selectionRationale: `Deterministic first tracked regular SVGs classified ${classification}; analyzer inventory only.`,
    legalDisposition: `${LOCAL_ONLY} v0.3 explicitly forbids an import acceptance shard for this corpus.`,
    lifecycle: false,
  }));
}

/**
 * @param {CorpusInput} input
 * @param {ProductApi} product
 * @returns {readonly ShardDefinition[]}
 */
function shardDefinitions(input, product) {
  if (input.id === "simple-icons") return simpleShards(input, product);
  if (input.id === "lucide") return lucideShards(input, product);
  if (input.id === "tabler-icons") return tablerShards(input, product);
  return theSvgShards(input, product);
}

/**
 * @param {readonly GitBlob[]} entries
 */
function classificationSummary(entries) {
  const result = { directlyImportable: 0, importableWithNormalization: 0, unsupported: 0, unsafe: 0 };
  for (const entry of entries) {
    if (entry.classification === "directly_importable") result.directlyImportable += 1;
    else if (entry.classification === "importable_with_normalization") result.importableWithNormalization += 1;
    else if (entry.classification === "unsupported") result.unsupported += 1;
    else result.unsafe += 1;
  }
  return result;
}

/**
 * @param {ShardDefinition} shard
 * @param {string} directory
 * @param {ProductApi} product
 */
async function qualifyLifecycle(shard, directory, product) {
  const archive = join(directory, "source.zip");
  await writeFile(archive, zipSync(Object.fromEntries(shard.entries.map((entry) => [entry.path, entry.bytes])), { level: 0, mtime: FIXED_ZIP_TIME }));
  const analysis = await product.analyze({ input: archive });
  const project = join(directory, "project");
  await mkdir(project, { recursive: true });
  const map = join(directory, "normalization-map.toml");
  if (shard.accessibilityAuthority === "consumer_labelled") {
    await writeFile(map, 'schema_version = 1\n\n[defaults]\nunlabelled_mode = "consumer_labelled"\n', "utf8");
  }
  await product.importProject({
    archive,
    root: project,
    schema: 2,
    normalize: "exact-common",
    ...(shard.accessibilityAuthority === "consumer_labelled" ? { normalizationMap: map } : {}),
  });
  await product.buildProject(project);
  const check = await product.checkProject(project);
  const listed = await product.listProject(project);
  await product.bundleProject({ root: project, output: "first.zip" });
  await product.bundleProject({ root: project, output: "second.zip" });
  const first = await readFile(join(project, "first.zip"));
  const second = await readFile(join(project, "second.zip"));
  if (!first.equals(second)) throw new Error(`${shard.name} bundle output was not deterministic.`);
  const reimport = join(directory, "manifest-reimport");
  await mkdir(reimport, { recursive: true });
  await product.importProject({ archive: join(project, "first.zip"), root: reimport, schema: 2, manifest: true });
  await product.buildProject(reimport);
  const reimportCheck = await product.checkProject(reimport);

  const checkClean = !check.sourceChanged && check.build.missing.length === 0 && check.build.different.length === 0;
  const manifestReimportClean = !reimportCheck.sourceChanged && reimportCheck.build.missing.length === 0 && reimportCheck.build.different.length === 0;
  const counts = analysis.data?.profiles?.commonV03?.counts ?? analysis.summary;
  const analyzeClean = (analysis.status === "ok" || analysis.status === "drift") && (counts.unsafe ?? 0) === 0 && (counts.unsupported ?? 0) === 0;
  const status = (checkClean && manifestReimportClean && analyzeClean) ? "qualified" : "failed";
  if (status !== "qualified") {
    throw new Error(`${shard.name} lifecycle qualification failed (check: ${checkClean}, reimport: ${manifestReimportClean}, analysis: ${analyzeClean}).`);
  }

  return {
    status,
    analyzeStatus: analysis.status,
    assetCount: listed.assets.length,
    checkClean,
    manifestReimportClean,
    bundleSha256: digest(first),
  };
}

/**
 * @param {CorpusInput} input
 * @param {string} scratchRoot
 * @param {ProductApi} product
 */
async function qualifyCorpus(input, scratchRoot, product) {
  const before = repositoryState(input);
  if (before.head !== input.revision) throw new Error(`${input.id} HEAD ${before.head} does not match pinned revision ${input.revision}.`);
  const directory = join(scratchRoot, input.id);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const shards = [];
  for (const shard of shardDefinitions(input, product)) {
    if (shard.entries.length === 0) throw new Error(`${shard.name} has no representative entries.`);
    const shardDirectory = join(directory, shard.name);
    await mkdir(shardDirectory, { recursive: true });
    const lifecycleOutcome = shard.lifecycle
      ? await qualifyLifecycle(shard, shardDirectory, product)
      : { status: "inventory_only", reason: "theSVG has no v0.3 import acceptance shard." };
    const manifestBody = {
      schema: "tfsb-dogfood-shard-manifest",
      schemaVersion: 1,
      corpus: input.id,
      origin: before.origin,
      revision: input.revision,
      shard: shard.name,
      selectionRationale: shard.selectionRationale,
      legalDisposition: shard.legalDisposition,
      normalizationAuthority: shard.accessibilityAuthority,
      entries: shard.entries.map((entry) => ({ path: entry.path, gitMode: entry.mode, gitBlobSha: entry.sha, byteCount: entry.bytes.byteLength })),
      analyzer: classificationSummary(shard.entries),
      lifecycleOutcome,
    };
    const manifestDigest = digest(stableJson(manifestBody));
    await writeFile(join(shardDirectory, "manifest.json"), stableJson({ ...manifestBody, manifestDigest }), "utf8");
    shards.push({
      name: shard.name,
      selectedCount: shard.entries.length,
      manifestDigest,
      analyzer: manifestBody.analyzer,
      normalizationAuthority: shard.accessibilityAuthority,
      selectionRationale: shard.selectionRationale,
      legalDisposition: shard.legalDisposition,
      lifecycleOutcome,
    });
  }
  const after = repositoryState(input);
  if (stableJson(after) !== stableJson(before)) throw new Error(`${input.id} checkout state changed during qualification.`);
  return { corpus: input.id, origin: before.origin, revision: input.revision, before: { head: before.head, dirty: before.dirty }, after: { head: after.head, dirty: after.dirty }, shards };
}

/**
 * @returns {Promise<ProductApi>}
 */
async function loadProduct() {
  const productUrl = new URL("../dist/index.js", import.meta.url);
  const scannerUrl = new URL("../dist/analyze-scanner.js", import.meta.url);
  try {
    const product = await import(productUrl.href);
    const scanner = await import(scannerUrl.href);
    return {
      analyze: product.analyze,
      buildProject: product.buildProject,
      bundleProject: product.bundleProject,
      checkProject: product.checkProject,
      importProject: product.importProject,
      listProject: product.listProject,
      scanAnalyzeSvg: scanner.scanAnalyzeSvg,
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load product modules: ${details}. Run 'npm run build' first.`);
  }
}

/**
 * @param {QualificationOptions} options
 */
export async function qualifyDogfoodShards(options) {
  const product = await loadProduct();
  await mkdir(options.scratchRoot, { recursive: true });
  const scratchRoot = await realpath(options.scratchRoot);
  const corpora = [];
  for (const input of [...options.corpora].sort((left, right) => compareText(left.id, right.id))) {
    corpora.push(await qualifyCorpus(input, scratchRoot, product));
  }
  const aggregate = { schema: "tfsb-dogfood-shard-qualification", schemaVersion: 1, corpora };
  const aggregateDigest = digest(stableJson(aggregate));
  const result = { ...aggregate, aggregateDigest };
  if (options.aggregateOutput !== undefined) await writeFile(options.aggregateOutput, stableJson(result), "utf8");
  return result;
}

const DEFAULT_CORPORA = /** @type {const} */ ([
  { id: "lucide", checkout: resolve(process.env.HOME ?? "", "projs/dogfood/svg/lucide"), revision: "33a44aa8b0b43d9b0ed14eb08860a1b5550a1573" },
  { id: "simple-icons", checkout: resolve(process.env.HOME ?? "", "projs/dogfood/svg/simple-icons"), revision: "34c22501f9ac9f22b12f825677ccbab1fb22e14b" },
  { id: "tabler-icons", checkout: resolve(process.env.HOME ?? "", "projs/dogfood/svg/tabler-icons"), revision: "5a0fe38e97784d94279ce4eb1bf85f9a91bf027e" },
  { id: "thesvg", checkout: resolve(process.env.HOME ?? "", "projs/dogfood/svg/thesvg"), revision: "df53f7020a3a0345918abc9924ef5eda82e28038" },
]);

/**
 * @param {readonly string[]} argv
 * @returns {QualificationOptions}
 */
function parseArguments(argv) {
  const corpora = [];
  let scratchRoot;
  let aggregateOutput;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--corpus" && value !== undefined) {
      corpora.push(JSON.parse(value));
      index += 1;
    } else if (argument === "--scratch-root" && value !== undefined) {
      scratchRoot = resolve(value);
      index += 1;
    } else if (argument === "--aggregate-output" && value !== undefined) {
      aggregateOutput = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument '${argument ?? ""}'.`);
    }
  }
  return {
    corpora: corpora.length > 0 ? corpora : DEFAULT_CORPORA,
    scratchRoot: scratchRoot ?? "/tmp/tfsb-dogfood-scratch",
    ...(aggregateOutput === undefined ? {} : { aggregateOutput }),
  };
}

async function main() {
  const result = await qualifyDogfoodShards(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${stableJson(result)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
