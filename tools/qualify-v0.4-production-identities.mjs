#!/usr/bin/env node
// @ts-check

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { stableJson } from "./audit-dogfood-corpus.mjs";
import { compareUtf8, svgPaths } from "./project-v0.4-collection-identities.mjs";

/** @typedef {typeof import("../src/index.js")} ProductModule */

/** @returns {Promise<ProductModule>} */
async function loadProduct() {
  const productUrl = new URL("../dist/index.js", import.meta.url);
  try {
    return await import(productUrl.href);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load compiled product from '${productUrl.href}': ${details}. Run 'npm run build' first.`);
  }
}

/** @template T @param {import("../src/index.js").Result<T>} result @returns {T} */
function unwrap(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

/**
 * @param {string} name
 * @param {ProductModule} product
 * @returns {Promise<import("../src/index.js").SourceMapV1>}
 */
async function example(name, product) {
  return unwrap(product.parseSourceMap(await readFile(resolve(`docs/examples/v0.4/${name}`), "utf8"), name));
}

/** @param {string} root @param {readonly string[]} paths @returns {import("../src/index.js").SourceSelectionCandidate[]} */
function candidates(root, paths) {
  return paths.map((path) => ({ sourcePath: `${root}/${path}`, kind: "file" }));
}

/** @param {string} id @param {string} path @returns {readonly [string, string]} */
function pair(id, path) { return [id, path]; }

/** @param {readonly (readonly [string, string])[]} values */
function collisionGroups(values) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const [id, path] of values) {
    const paths = groups.get(id) ?? [];
    paths.push(path);
    groups.set(id, paths);
  }
  return [...groups.values()].filter((paths) => paths.length > 1).length;
}

/**
 * @param {string} root
 * @param {string} collectionRoot
 * @param {import("../src/index.js").SourceMapV1} map
 * @param {readonly string[]} collectionIds
 * @param {ProductModule} product
 */
async function qualifyMapped(root, collectionRoot, map, collectionIds, product) {
  const inventory = await svgPaths(resolve(root, collectionRoot));
  const boundedMap = { ...map, collections: map.collections.filter((collection) => collectionIds.includes(collection.id)) };
  const selection = unwrap(product.evaluateSourceMapSelection(boundedMap, candidates(collectionRoot, inventory.paths)));
  const identities = unwrap(product.deriveSourceMapIdentities(boundedMap, selection));
  return {
    regularSvgPathCount: inventory.paths.length,
    selectedIdentityCount: identities.length,
    selectedIdentityCollisionGroups: collisionGroups(identities.map((identity) => pair(identity.assetId, identity.sourcePath))),
    symlinkCount: inventory.symlinks.length,
    specialFileCount: inventory.specialFiles.length,
  };
}

/** @param {Record<string, string>} roots @param {string} key */
function requiredRoot(roots, key) {
  const value = roots[key];
  if (value === undefined) throw new Error(`Missing --${key} checkout.`);
  return value;
}

/**
 * @param {Record<string, string>} roots
 * @param {ProductModule} [product]
 */
export async function qualifyProductionIdentities(roots, product) {
  const prod = product ?? await loadProduct();
  const simpleMap = await example("simple-icons-source-map.toml", prod);
  const lucideMap = await example("lucide-source-map.toml", prod);
  const tablerMap = await example("tabler-source-map.toml", prod);
  const simple = await qualifyMapped(requiredRoot(roots, "simple-icons"), "icons", simpleMap, ["simple-icons"], prod);
  const lucide = await qualifyMapped(requiredRoot(roots, "lucide"), "icons", lucideMap, ["lucide"], prod);
  const tablerRoot = requiredRoot(roots, "tabler-icons");
  const tablerOutline = await qualifyMapped(tablerRoot, "icons/outline", tablerMap, ["tabler-outline"], prod);
  const tablerFilled = await qualifyMapped(tablerRoot, "icons/filled", tablerMap, ["tabler-filled"], prod);

  const outlinePaths = (await svgPaths(resolve(tablerRoot, "icons/outline"))).paths;
  const filledPaths = (await svgPaths(resolve(tablerRoot, "icons/filled"))).paths;
  const tablerUnprefixed = collisionGroups([
    ...outlinePaths.map((path) => pair(prod.deriveSourceMapIdCandidate(path, "basename").assetId, `outline:${path}`)),
    ...filledPaths.map((path) => pair(prod.deriveSourceMapIdCandidate(path, "basename").assetId, `filled:${path}`)),
  ]);
  const tablerPrefixed = collisionGroups([
    ...outlinePaths.map((path) => pair(prod.deriveSourceMapIdCandidate(path, "basename", "outline-").assetId, `outline:${path}`)),
    ...filledPaths.map((path) => pair(prod.deriveSourceMapIdCandidate(path, "basename", "filled-").assetId, `filled:${path}`)),
  ]);

  const theSvgInventory = await svgPaths(resolve(requiredRoot(roots, "thesvg"), "public/icons"));
  const theSvgMap = unwrap(prod.parseSourceMap(`schema_version = 1
source_root = "."
[[collection]]
id = "thesvg"
name = "theSVG"
root = "public/icons"
identity = "relative-path"
prefix = ""
include_paths = []
include_trees = ["."]
exclude_paths = []
exclude_trees = []
`));
  const theSvgSelection = unwrap(prod.evaluateSourceMapSelection(theSvgMap, candidates("public/icons", theSvgInventory.paths)));
  const theSvgCandidates = theSvgSelection.map((selection) => ({ path: selection.sourcePath, ...prod.deriveSourceMapIdCandidate(selection.collectionPath, "relative-path") }));

  return {
    kind: "tfsb-v0.4-production-identity-qualification",
    schemaVersion: 1,
    collections: {
      simpleIcons: simple,
      lucide,
      tablerOutline,
      tablerFilled,
      theSvg: {
        regularSvgPathCount: theSvgInventory.paths.length,
        relativePathCollisionGroups: collisionGroups(theSvgCandidates.map((candidate) => pair(candidate.assetId, candidate.path))),
        overlongIdentityCount: theSvgCandidates.filter((candidate) => candidate.overflow).length,
        maximumIdentityBytes: Math.max(...theSvgCandidates.map((candidate) => candidate.utf8Bytes)),
      },
    },
    tablerCrossCollection: { withoutPrefixes: tablerUnprefixed, withDisjointPrefixes: tablerPrefixed },
  };
}

/** @param {string[]} args */
function argumentsFor(args) {
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
  const options = argumentsFor(process.argv.slice(2));
  await writeFile(options.output, stableJson(await qualifyProductionIdentities(options.roots)), "utf8");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
