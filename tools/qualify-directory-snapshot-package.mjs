#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "tfsb-packed-native-"));
const packageName = "@knowledge-forge-ai/theme-forge-stellar-burst";
const artifact = process.platform === "linux" ? "linux-x64-gnu" : `darwin-${process.arch}`;

/** @param {string} executable @param {string[]} args @param {string} cwd @returns {string} */
function command(executable, args, cwd) {
  return execFileSync(executable, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {string} name */
function installConsumer(name) {
  const root = join(scratch, name);
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), '{"name":"native-consumer","private":true,"type":"module"}\n');
  command("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball], root);
  const installedRoot = join(root, "node_modules", "@knowledge-forge-ai", "theme-forge-stellar-burst");
  const manifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    if (manifest.scripts?.[lifecycle] !== undefined) throw new Error(`Unexpected package lifecycle script: ${lifecycle}`);
  }
  return { root, installedRoot };
}

/** @param {string} consumerRoot @param {boolean} expectedSupported */
function probe(consumerRoot, expectedSupported) {
  const output = command(process.execPath, ["--input-type=module", "-e", `
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { zipSync } = await import("fflate");
    const pkg = await import(${JSON.stringify(packageName)});
    const source = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tfsb-packed-probe-"));
    try {
      fs.mkdirSync(path.join(source, "icons"));
      const svg = '<?xml version="1.0" encoding="UTF-8"?>\\n<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" role="img" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\\n  <circle cx="12" cy="12" r="8"/>\\n  <line x1="4" y1="12" x2="20" y2="12"/>\\n  <rect x="9" y="9" width="6" height="6" rx="1" ry="1"/>\\n</svg>\\n';
      fs.writeFileSync(path.join(source, "icons", "asset.svg"), svg);
      fs.writeFileSync(path.join(source, ".tfsb-source-map.toml"), 'schema_version = 1\\nsource_root = "."\\n[[collection]]\\nid = "icons"\\nname = "Icons"\\nroot = "icons"\\nidentity = "basename"\\nprefix = ""\\ninclude_paths = []\\ninclude_trees = ["."]\\nexclude_paths = []\\nexclude_trees = []\\n');
      const mapResult = pkg.parseSourceMap('schema_version = 1\\nsource_root = "."\\n[[collection]]\\nid = "icons"\\nname = "Icons"\\nroot = "icons"\\nidentity = "basename"\\nprefix = ""\\ninclude_paths = []\\ninclude_trees = ["."]\\nexclude_paths = []\\nexclude_trees = []\\n');
      if (!mapResult.ok) throw new Error("map parse failed");
      const capability = pkg.getDirectorySnapshotCapability(source);
      const discovery = await pkg.discoverDirectorySources(source, mapResult.value);
      const snapshot = await pkg.createDirectorySnapshot(source, mapResult.value);
      let revalidated = false;
      if (snapshot.ok) {
        const result = await pkg.revalidateDirectorySnapshot(snapshot.value, mapResult.value);
        revalidated = result.ok;
        pkg.closeDirectorySnapshot(snapshot.value);
      }
      const analyzeResult = await pkg.analyze({ input: source });
      const archivePath = path.join(source, "source.zip");
      fs.writeFileSync(archivePath, zipSync({ "asset.svg": new TextEncoder().encode(svg) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
      const archiveRoot = path.join(source, "archive-project"); fs.mkdirSync(archiveRoot);
      const archiveImport = await pkg.importProject({ archive: archivePath, root: archiveRoot, schema: 2, recordProvenance: true });
      const archiveReconcile = await pkg.reconcileProject({ archive: archivePath, root: archiveRoot });
      const shardPlan = await pkg.planShard(source, mapResult.value, "icons", ["asset.svg"]);
      if (!shardPlan.ok) throw new Error("shard planning failed: " + shardPlan.diagnostics[0]?.code);
      fs.writeFileSync(path.join(source, ".tfsb-workspace.toml"), 'schema_version = 1\\nid = "packed-workspace"\\nname = "Packed workspace"\\n\\n[[project]]\\nid = "archive-project"\\npath = "archive-project"\\ncollections = ["icons"]\\n');
      fs.rmSync(archivePath);
      const workspaceFile = path.join(source, ".tfsb-workspace.toml");
      const workspaceList = await pkg.listWorkspace({ workspaceFile });
      const workspaceCheck = await pkg.checkWorkspace({ workspaceFile });
      const workspacePreview = await pkg.previewWorkspace({ workspaceFile });
      const shardManifest = source + "-shard.toml";
      fs.writeFileSync(shardManifest, pkg.serializeShardManifest(shardPlan.value));
      const directoryRoot = path.join(source, "directory-project"); fs.mkdirSync(directoryRoot);
      let directoryImport = false;
      let directoryImportCode = null;
      let directoryReconcile = false;
      let directoryReconcileCode = null;
      let shardImport = false;
      let shardImportCode = null;
      try {
        const imported = await pkg.importProject({ source: { kind: "directory", path: source }, root: directoryRoot, collections: ["icons"] });
        directoryImport = imported.sourceKind === "directory";
        const reconciled = await pkg.reconcileProject({ directory: source, root: directoryRoot, sourceMap: path.join(source, ".tfsb-source-map.toml"), collections: ["icons"] });
        directoryReconcile = reconciled.blocked === false;
      } catch (error) {
        directoryImportCode = error?.diagnostic?.code ?? null;
        directoryReconcileCode = error?.diagnostic?.code ?? null;
      }
      const shardRoot = path.join(source, "shard-project"); fs.mkdirSync(shardRoot);
      try {
        const imported = await pkg.importProject({ source: { kind: "directory", path: source }, root: shardRoot, sourceMap: path.join(source, ".tfsb-source-map.toml"), shardManifest });
        shardImport = imported.sourceKind === "directory" && imported.assets.length === 1;
      } catch (error) {
        shardImportCode = error?.diagnostic?.code ?? null;
      }
      if (${JSON.stringify(!expectedSupported)}) {
        try {
          await pkg.reconcileProject({ directory: source, root: archiveRoot, sourceMap: path.join(source, ".tfsb-source-map.toml"), collections: ["icons"], acceptSourceKindChange: "archive=directory" });
        } catch (error) {
          directoryReconcileCode = error?.diagnostic?.code ?? null;
        }
      }
      process.stdout.write(JSON.stringify({
        supported: capability.supported,
        discovery: discovery.ok,
        snapshot: snapshot.ok,
        revalidated,
        snapshotCode: snapshot.ok ? null : snapshot.diagnostics[0]?.code,
        analyzeDirectory: analyzeResult.data.input.kind === "directory" && analyzeResult.data.scanCompleted === true,
        archiveImport: archiveImport.sourceKind === "archive",
        archiveReconcile: archiveReconcile.blocked === false,
        shardPlan: shardPlan.ok,
        workspaceList: workspaceList.workspace.recordCount === 1,
        workspaceCheck: workspaceCheck.status !== "error",
        workspacePreview: workspacePreview.assetCount === 1,
        directoryImport,
        directoryImportCode,
        directoryReconcile,
        directoryReconcileCode,
        shardImport,
        shardImportCode,
      }));
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(source + "-shard.toml", { force: true });
    }
  `], consumerRoot);
  const result = JSON.parse(output);
  if (result.supported !== expectedSupported || result.discovery !== true || result.analyzeDirectory !== true || result.archiveImport !== true || result.archiveReconcile !== true || result.shardPlan !== true || result.workspaceList !== true || result.workspaceCheck !== true || result.workspacePreview !== true) {
    throw new Error("Packed consumer capability/discovery qualification failed.");
  }
  if (expectedSupported && (result.snapshot !== true || result.revalidated !== true)) {
    throw new Error("Packed consumer authenticated snapshot qualification failed.");
  }
  if (!expectedSupported && (result.snapshot !== false || result.snapshotCode !== "DIRECTORY_SNAPSHOT_UNSUPPORTED")) {
    throw new Error("Packed consumer unsupported fallback qualification failed.");
  }
  if (expectedSupported && result.directoryImport !== true) throw new Error("Packed consumer directory import qualification failed.");
  if (!expectedSupported && (result.directoryImport !== false || result.directoryImportCode !== "DIRECTORY_SNAPSHOT_UNSUPPORTED")) throw new Error("Packed consumer directory import fallback qualification failed.");
  if (expectedSupported && (result.directoryReconcile !== true || result.shardImport !== true)) throw new Error("Packed consumer directory reconcile/shard materialization qualification failed.");
  if (!expectedSupported && (result.directoryReconcileCode !== "DIRECTORY_SNAPSHOT_UNSUPPORTED" || result.shardImportCode !== "DIRECTORY_SNAPSHOT_UNSUPPORTED")) throw new Error("Packed consumer directory reconcile/shard materialization fallback qualification failed.");
  return result;
}

/** @type {string} */
let tarball = "";
try {
  const pack = JSON.parse(command("npm", ["pack", "--json", "--pack-destination", scratch], repositoryRoot));
  if (!Array.isArray(pack) || pack.length !== 1 || typeof pack[0]?.filename !== "string") throw new Error("npm pack returned an invalid result.");
  tarball = join(scratch, pack[0].filename);
  const frozen = process.argv[2];
  if (frozen) {
    const digest = (/** @type {string} */ file) => createHash("sha256").update(readFileSync(file)).digest("hex");
    if (digest(tarball) !== digest(frozen)) throw new Error("Frozen artifact differs from qualified package bytes.");
    tarball = resolve(frozen);
  }
  const first = installConsumer("consumer-one");
  const second = installConsumer("consumer-two");
  const firstResult = probe(first.root, true);
  const secondResult = probe(second.root, true);

  const installedArtifact = join(second.installedRoot, "native/directory-snapshot/prebuilds", artifact, "native-addon-posix-openat-v1.node");
  rmSync(installedArtifact);
  const missingResult = probe(second.root, false);
  writeFileSync(installedArtifact, "corrupt native artifact");
  const corruptResult = probe(second.root, false);

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    packageVersion: pack[0].version,
    packageEntries: pack[0].entryCount,
    packageBytes: pack[0].size,
    packageUnpackedBytes: pack[0].unpackedSize,
    artifact,
    installs: [firstResult, secondResult],
    missingArtifact: missingResult,
    corruptArtifact: corruptResult,
    lifecycleCompileScripts: false,
  }, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
