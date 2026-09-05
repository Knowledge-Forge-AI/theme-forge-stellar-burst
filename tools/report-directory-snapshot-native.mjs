#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {typeof import("../src/index.js")} ProductModule */
/** @typedef {typeof import("../src/directory-snapshot-native.js")} NativeLoaderModule */

async function loadModules() {
  const indexUrl = new URL("../dist/index.js", import.meta.url);
  const nativeUrl = new URL("../dist/directory-snapshot-native.js", import.meta.url);
  try {
    /** @type {ProductModule} */
    const product = await import(indexUrl.href);
    /** @type {NativeLoaderModule} */
    const native = await import(nativeUrl.href);
    return {
      getDirectorySnapshotCapability: product.getDirectorySnapshotCapability,
      loadDirectorySnapshotNative: native.loadDirectorySnapshotNative,
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load compiled product modules: ${details}. Run 'npm run build' first.`);
  }
}

const { getDirectorySnapshotCapability, loadDirectorySnapshotNative } = await loadModules();

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loaded = loadDirectorySnapshotNative();
if (!loaded.ok) throw new Error(`Native directory snapshot qualification failed: ${loaded.reason}`);
const physicalTemporaryRoot = realpathSync(tmpdir());
const capability = getDirectorySnapshotCapability(physicalTemporaryRoot);
if (!capability.supported) throw new Error("Native directory snapshot filesystem is not qualified.");

const handles = [loaded.addon.openFilesystemRoot()];
try {
  for (const component of physicalTemporaryRoot.slice(1).split("/")) {
    const parent = handles.at(-1);
    if (parent === undefined) throw new Error("Native directory snapshot ancestry is empty.");
    handles.push(loaded.addon.openChildDirectory(parent, component));
  }
  const sourceRoot = handles.at(-1);
  if (sourceRoot === undefined) throw new Error("Native directory snapshot ancestry is empty.");
  const filesystem = loaded.addon.statFilesystem(sourceRoot);
  const manifest = JSON.parse(readFileSync(join(
    repositoryRoot,
    "native/directory-snapshot/prebuilds",
    loaded.artifact,
    "manifest.json",
  ), "utf8"));
  process.stdout.write(`${JSON.stringify({
    qualificationSchemaVersion: 1,
    backend: loaded.addon.backend,
    abiVersion: loaded.addon.abiVersion,
    artifact: loaded.artifact,
    nodeVersion: process.version,
    nodeApiVersion: process.versions.napi,
    platform: process.platform,
    architecture: process.arch,
    filesystemClass: filesystem.class,
    filesystemCategory: filesystem.category,
    capability,
    manifest,
  }, null, 2)}\n`);
} finally {
  for (const handle of handles.reverse()) loaded.addon.closeHandle(handle);
}
