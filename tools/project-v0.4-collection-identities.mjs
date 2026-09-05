#!/usr/bin/env node
// @ts-check

import { createHash } from "node:crypto";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { stableJson } from "./audit-dogfood-corpus.mjs";

const DERIVED_ID_MAX_BYTES = 64;
const SHARD_SIZES = [16, 32, 128];
/** @type {Record<string, readonly string[]>} */
const REMOTES = {
  "simple-icons": ["git@github.com:simple-icons/simple-icons", "https://github.com/simple-icons/simple-icons.git"],
  lucide: ["git@github.com:lucide-icons/lucide.git", "https://github.com/lucide-icons/lucide.git"],
  "tabler-icons": ["git@github.com:tabler/tabler-icons.git", "https://github.com/tabler/tabler-icons.git"],
  thesvg: ["git@github.com:glincker/thesvg.git", "https://github.com/glincker/thesvg.git"],
};

/** @type {readonly {corpusId:string, collectionId:string, root:string, strategy:"basename" | "relative-path", prefix:string}[]} */
const CONFIG = [
  { corpusId: "simple-icons", collectionId: "simple-icons", root: "icons", strategy: "basename", prefix: "" },
  { corpusId: "lucide", collectionId: "lucide", root: "icons", strategy: "basename", prefix: "" },
  { corpusId: "tabler-icons", collectionId: "tabler-outline", root: "icons/outline", strategy: "basename", prefix: "outline-" },
  { corpusId: "tabler-icons", collectionId: "tabler-filled", root: "icons/filled", strategy: "basename", prefix: "filled-" },
  { corpusId: "thesvg", collectionId: "thesvg", root: "public/icons", strategy: "relative-path", prefix: "" },
];

/** @param {string} left @param {string} right */
export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** @param {string} value */
function lowerAscii(value) {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** @param {string} value */
function identityTokens(value) {
  return lowerAscii(value.normalize("NFC"))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * v0.4 source-map schema-1 derivation candidate. Explicit overrides are not
 * applied here: overflow, empty, and collision results are evidence that an
 * override is required rather than authority to invent a suffix.
 * @param {string} path
 * @param {"basename" | "relative-path"} strategy
 * @param {string} prefix
 */
export function deriveSourceMapId(path, strategy, prefix = "") {
  const withoutExtension = path.slice(0, -extname(path).length);
  const basis = strategy === "basename" ? basename(withoutExtension) : withoutExtension.split("/").map(identityTokens).filter(Boolean).join("-");
  const id = `${prefix}${identityTokens(basis)}`;
  return {
    id,
    valid: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id),
    bytes: Buffer.byteLength(id, "utf8"),
    overflow: Buffer.byteLength(id, "utf8") > DERIVED_ID_MAX_BYTES,
  };
}

/** @param {Map<string, string[]>} groups */
function collisionSummary(groups) {
  const collisions = [...groups.entries()]
    .filter(([, paths]) => paths.length > 1)
    .sort(([left], [right]) => compareUtf8(left, right));
  return {
    groups: collisions.length,
    affectedFiles: collisions.reduce((total, [, paths]) => total + paths.length, 0),
    excessFiles: collisions.reduce((total, [, paths]) => total + paths.length - 1, 0),
    samples: collisions.slice(0, 5).map(([key, paths]) => ({ key, paths: [...paths].sort(compareUtf8).slice(0, 5) })),
  };
}

/** @param {Map<string, string[]>} groups @param {string} key @param {string} path */
function addGroup(groups, key, path) {
  const values = groups.get(key);
  if (values === undefined) groups.set(key, [path]);
  else values.push(path);
}

/** @param {string} component */
function nonportableComponent(component) {
  if (component !== component.normalize("NFC")) return true;
  if (component === "" || component === "." || component === "..") return true;
  if (/[. ]$/.test(component) || /^ /.test(component) || /[\u0000-\u001f\u007f]/.test(component)) return true;
  if (Buffer.byteLength(component, "utf8") > 255) return true;
  const stem = (component.includes(".") ? component.slice(0, component.indexOf(".")) : component).toLowerCase();
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem);
}

/** @param {string} path */
export function portablePathIssue(path) {
  const components = path.split("/");
  if (path !== path.normalize("NFC") || path.startsWith("/") || path.includes("\\") || Buffer.byteLength(path, "utf8") > 1024) return true;
  return components.some((component) => nonportableComponent(component));
}

/** @param {string} command @param {string[]} args @param {string} cwd */
function run(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

/** @param {string} root */
async function repositoryEvidence(root) {
  const remoteResult = await run("git", ["remote", "get-url", "origin"], root);
  const headResult = await run("git", ["rev-parse", "HEAD"], root);
  const statusResult = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
  const treeResult = await run("git", ["ls-tree", "-r", "-z", "HEAD"], root);
  if (remoteResult.code !== 0 || headResult.code !== 0 || statusResult.code !== 0 || treeResult.code !== 0) throw new Error("Dogfood Git evidence could not be read.");
  const remote = remoteResult.stdout.trim();
  const modes = treeResult.stdout.split("\0").filter(Boolean).map((/** @type {string} */ line) => {
    const match = line.match(/^(\d+)\s+\w+\s+[0-9a-f]+\t(.+)$/);
    if (match === null) throw new Error("Unexpected git ls-tree record.");
    return { mode: match[1], path: match[2] };
  });
  /** @type {{mode:string, path:string}[]} */
  const typedModes = modes;
  return {
    remote,
    head: headResult.stdout.trim(),
    clean: statusResult.stdout === "",
    trackedSymlinks: typedModes.filter((entry) => entry.mode === "120000").map((entry) => entry.path).sort(compareUtf8),
    trackedSpecialEntries: typedModes.filter((entry) => !["100644", "100755", "120000"].includes(entry.mode)).map((entry) => ({ mode: entry.mode, path: entry.path })).sort((left, right) => compareUtf8(left.path, right.path)),
  };
}

/** @param {string} root */
export async function svgPaths(root) {
  /** @type {string[]} */
  const paths = [];
  /** @type {string[]} */
  const symlinks = [];
  /** @type {string[]} */
  const specialFiles = [];
  /** @param {string} directory */
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/").normalize("NFC");
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) symlinks.push(path);
      else if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile() && extname(entry.name) === ".svg") paths.push(path);
      else if (!stat.isFile()) specialFiles.push(path);
    }
  }
  await walk(root);
  paths.sort(compareUtf8);
  symlinks.sort(compareUtf8);
  specialFiles.sort(compareUtf8);
  return { paths, symlinks, specialFiles };
}

/** @param {string[]} paths @param {number} size */
export function shardProjection(paths, size) {
  const sorted = [...paths].sort(compareUtf8);
  const membership = sorted.slice(0, size);
  const bytes = `${membership.join("\n")}\n`;
  return {
    requestedSize: size,
    assetCount: membership.length,
    membershipBasis: "utf8-sorted-source-paths-v1",
    membershipSha256: `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`,
    membership,
  };
}

/** @param {string} repositoryRoot @param {string} collectionRoot */
async function analyzerProjection(repositoryRoot, collectionRoot) {
  const result = await run(process.execPath, [resolve("dist/cli.js"), "analyze", resolve(repositoryRoot, collectionRoot), "--json"], resolve("."));
  if (![0, 1, 2].includes(result.code)) throw new Error(`Analyzer failed: ${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  if (envelope.data?.scanCompleted !== true) throw new Error("Analyzer did not complete the requested collection scan.");
  return {
    status: envelope.status,
    exitCode: envelope.exitCode,
    schema1: envelope.data.profiles.schema1.counts,
    commonV03: envelope.data.profiles.commonV03.counts,
    commonV03DiagnosticCounts: envelope.data.profiles.commonV03.diagnosticCounts,
    commonV03NormalizationCounts: envelope.data.profiles.commonV03.normalizationCounts,
    commonV03FeatureCounts: envelope.data.profiles.commonV03.featureCounts,
  };
}

/** @param {Record<string, string>} roots */
export async function buildCollectionProjection(roots) {
  /** @type {Record<string, Awaited<ReturnType<typeof repositoryEvidence>>>} */
  const repositories = {};
  for (const corpusId of Object.keys(REMOTES).sort(compareUtf8)) {
    const root = roots[corpusId];
    if (root === undefined) throw new Error(`Missing --${corpusId} checkout.`);
    const evidence = await repositoryEvidence(root);
    const allowedRemotes = REMOTES[corpusId];
    if (allowedRemotes === undefined || !allowedRemotes.includes(evidence.remote)) throw new Error(`Unexpected ${corpusId} origin remote.`);
    if (!evidence.clean) throw new Error(`${corpusId} worktree is not clean.`);
    repositories[corpusId] = evidence;
  }

  const collections = [];
  for (const config of CONFIG) {
    const repositoryRoot = roots[config.corpusId];
    if (repositoryRoot === undefined) throw new Error(`Missing ${config.corpusId} checkout.`);
    const inventory = await svgPaths(resolve(repositoryRoot, config.root));
    const basenameGroups = new Map();
    const relativeGroups = new Map();
    const selectedGroups = new Map();
    const portableGroups = new Map();
    const overflow = [];
    const invalid = [];
    const nonportable = [];
    for (const path of inventory.paths) {
      const basenameId = deriveSourceMapId(path, "basename");
      const relativeId = deriveSourceMapId(path, "relative-path");
      const selected = deriveSourceMapId(path, config.strategy, config.prefix);
      addGroup(basenameGroups, basenameId.id, path);
      addGroup(relativeGroups, relativeId.id, path);
      addGroup(selectedGroups, selected.id, path);
      addGroup(portableGroups, path.normalize("NFC").toLowerCase(), path);
      if (!selected.valid) invalid.push(path);
      if (selected.overflow) overflow.push({ path, derivedId: selected.id, bytes: selected.bytes });
      if (portablePathIssue(path)) nonportable.push(path);
    }
    collections.push({
      corpusId: config.corpusId,
      collectionId: config.collectionId,
      collectionRoot: config.root,
      identityStrategy: config.strategy,
      prefix: config.prefix,
      regularSvgPathCount: inventory.paths.length,
      basenameCollisions: collisionSummary(basenameGroups),
      relativePathDerivedCollisions: collisionSummary(relativeGroups),
      selectedIdentityCollisions: collisionSummary(selectedGroups),
      portableCaseCollisions: collisionSummary(portableGroups),
      invalidDerivedIdentityCount: invalid.length,
      derivedIdentityOverflowCount: overflow.length,
      derivedIdentityOverflowMaxBytes: overflow.reduce((maximum, item) => Math.max(maximum, item.bytes), 0),
      derivedIdentityOverflowSamples: overflow.slice(0, 5),
      nonportablePathCount: nonportable.length,
      nonportablePathSamples: nonportable.slice(0, 5),
      sourceRootSymlinks: inventory.symlinks,
      sourceRootSpecialFiles: inventory.specialFiles,
      boundedChildProjectsAt128: Math.ceil(inventory.paths.length / 128),
      representativePaths: inventory.paths.slice(0, 5),
      shardCandidates: SHARD_SIZES.map((size) => shardProjection(inventory.paths, size)),
      analyzer: await analyzerProjection(repositoryRoot, config.root),
    });
  }

  const tabler = collections.filter((collection) => collection.corpusId === "tabler-icons");
  const unprefixed = new Map();
  const prefixed = new Map();
  for (const collection of tabler) {
    const root = roots[collection.corpusId];
    if (root === undefined) throw new Error("Missing tabler-icons checkout.");
    const inventory = await svgPaths(resolve(root, collection.collectionRoot));
    for (const path of inventory.paths) {
      addGroup(unprefixed, deriveSourceMapId(path, "basename").id, `${collection.collectionId}:${path}`);
      addGroup(prefixed, deriveSourceMapId(path, "basename", collection.prefix).id, `${collection.collectionId}:${path}`);
    }
  }

  return {
    kind: "tfsb-v0.4-collection-identity-projection",
    schemaVersion: 1,
    generatedFrom: "read-only-clean-worktrees",
    identityPolicy: {
      strategies: ["explicit", "basename", "relative-path"],
      automaticOverrideModel: "basename-or-relative-path-plus-explicit-entry-overrides",
      sourceMapProducedIdGrammar: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      sourceMapProducedIdMaxUtf8Bytes: DERIVED_ID_MAX_BYTES,
      collisionDisposition: "fail_closed_requires_explicit_override",
      overflowDisposition: "fail_closed_requires_short_explicit_override",
    },
    repositories,
    collections,
    tablerCrossCollectionIdentity: {
      withoutPrefixes: collisionSummary(unprefixed),
      withDisjointPrefixes: collisionSummary(prefixed),
    },
    legalBoundary: "Compatibility and identity projection do not grant license, trademark, attribution, or redistribution permission.",
  };
}

/** @param {string[]} args */
function parseArguments(args) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) throw new Error("Expected --name value arguments.");
    values[key.slice(2)] = resolve(value);
  }
  const output = values.output;
  if (output === undefined) throw new Error("Missing --output path.");
  delete values.output;
  return { roots: values, output };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const projection = await buildCollectionProjection(options.roots);
  await writeFile(options.output, stableJson(projection), "utf8");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
