import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeDirectorySnapshot,
  createDirectorySnapshot,
  getDirectorySnapshotCapability,
  importProject,
  parseAssetTomlV2,
  parseSourceMap,
  serializeSvgV2,
} from "../src/index.js";
import { readRepoFile, repoPath, unwrap } from "./helpers.js";

const roots: string[] = [];
const artifact = process.platform === "linux" ? "linux-x64-gnu" : `darwin-${process.arch}`;
const addonPath = repoPath(`native/directory-snapshot/prebuilds/${artifact}/native-addon-posix-openat-v1.node`);
const nativeAvailable = getDirectorySnapshotCapability(realpathSync(tmpdir())).supported;

function physicalTempRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tfsb-cleanup-"));
  roots.push(root);
  return root;
}

function sourceMap() {
  return unwrap(parseSourceMap(`schema_version = 1
source_root = "."
[[collection]]
id = "icons"
name = "Icons"
root = "icons"
identity = "basename"
prefix = ""
include_paths = []
include_trees = ["."]
exclude_paths = []
exclude_trees = []
`));
}

function matchingDescriptorCount(path: string): number {
  const target = statSync(path);
  if (process.platform === "darwin") {
    const output = execFileSync("lsof", ["-a", "-p", String(process.pid), "-FnDi"], { encoding: "utf8" });
    let device = "";
    let inode = "";
    let count = 0;
    for (const line of output.split("\n")) {
      if (line.startsWith("f")) { device = ""; inode = ""; }
      else if (line.startsWith("D")) device = line.slice(1).toLowerCase();
      else if (line.startsWith("i")) {
        inode = line.slice(1);
        if (device === `0x${target.dev.toString(16)}` && inode === String(target.ino)) count += 1;
      }
    }
    return count;
  }
  let count = 0;
  for (const name of readdirSync("/proc/self/fd")) {
    try {
      const current = statSync(`/proc/self/fd/${name}`);
      if (current.dev === target.dev && current.ino === target.ino) count += 1;
    } catch { /* descriptor changed while inspecting */ }
  }
  return count;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(nativeAvailable)("native directory snapshot cleanup", () => {
  it("retains selected handles until explicit close and then releases them", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons"));
    const file = join(root, "icons", "asset.svg");
    writeFileSync(file, "x");
    expect(matchingDescriptorCount(file)).toBe(0);
    const snapshot = unwrap(await createDirectorySnapshot(root, sourceMap()));
    expect(matchingDescriptorCount(file)).toBe(1);
    closeDirectorySnapshot(snapshot);
    expect(matchingDescriptorCount(file)).toBe(0);
  });

  it("cleans selected handles when snapshot creation fails partway", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons"));
    const file = join(root, "icons", "asset.svg");
    writeFileSync(file, "x");
    linkSync(file, join(root, "second-link"));
    const result = await createDirectorySnapshot(root, sourceMap());
    expect(result.ok).toBe(false);
    expect(matchingDescriptorCount(file)).toBe(0);
  });

  it("releases importer handles across repeated dry-runs and planning failures", async () => {
    const root = physicalTempRoot();
    const source = join(root, "source");
    mkdirSync(join(source, "icons"), { recursive: true });
    const file = join(source, "icons", "asset.svg");
    const canonical = unwrap(serializeSvgV2(unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml"))).svg));
    writeFileSync(file, canonical);
    writeFileSync(join(source, ".tfsb-source-map.toml"), `schema_version = 1
source_root = "."
[[collection]]
id = "icons"
name = "Icons"
root = "icons"
identity = "basename"
prefix = ""
include_paths = []
include_trees = ["."]
exclude_paths = []
exclude_trees = []
`);
    for (let index = 0; index < 12; index += 1) {
      const target = join(root, `dry-${index}`); mkdirSync(target);
      await importProject({ source: { kind: "directory", path: source }, root: target, collections: ["icons"], dryRun: true });
      expect(matchingDescriptorCount(file)).toBe(0);
    }
    writeFileSync(file, "not an svg");
    const failedTarget = join(root, "failed"); mkdirSync(failedTarget);
    await expect(importProject({ source: { kind: "directory", path: source }, root: failedTarget, collections: ["icons"] })).rejects.toBeDefined();
    expect(matchingDescriptorCount(file)).toBe(0);
  });

  it("does not inherit authenticated file objects across subprocess exec", async () => {
    const root = physicalTempRoot();
    mkdirSync(join(root, "icons"));
    const file = join(root, "icons", "asset.svg");
    writeFileSync(file, "x");
    const snapshot = unwrap(await createDirectorySnapshot(root, sourceMap()));
    expect(matchingDescriptorCount(file)).toBe(1);
    const target = statSync(file);
    const childResult = execFileSync(process.execPath, ["-e", `
      const fs = require("node:fs");
      const targetDev = Number(process.argv[1]);
      const targetIno = Number(process.argv[2]);
      let inherited = false;
      if (process.platform === "darwin") {
        const output = require("node:child_process").execFileSync("lsof", ["-a", "-p", String(process.pid), "-FnDi"], { encoding: "utf8" });
        let device = "";
        for (const line of output.split("\\n")) {
          if (line.startsWith("f")) device = "";
          else if (line.startsWith("D")) device = line.slice(1).toLowerCase();
          else if (line.startsWith("i") && device === "0x" + targetDev.toString(16) && line.slice(1) === String(targetIno)) inherited = true;
        }
      } else {
        for (const name of fs.readdirSync("/proc/self/fd")) {
          try {
            const value = fs.statSync("/proc/self/fd/" + name);
            if (value.dev === targetDev && value.ino === targetIno) inherited = true;
          } catch {}
        }
      }
      process.stdout.write(String(inherited));
    `, String(target.dev), String(target.ino)], { encoding: "utf8" });
    expect(childResult).toBe("false");
    closeDirectorySnapshot(snapshot);
  });

  it("uses finalizers as a GC safety net", () => {
    const output = execFileSync(process.execPath, ["--expose-gc", "-e", `
      const fs = require("node:fs");
      const addon = require(process.argv[1]);
      const target = fs.statSync(process.argv[2]);
      function count() {
        if (process.platform === "darwin") {
          const output = require("node:child_process").execFileSync("lsof", ["-a", "-p", String(process.pid), "-FnDi"], { encoding: "utf8" });
          let device = "";
          let total = 0;
          for (const line of output.split("\\n")) {
            if (line.startsWith("f")) device = "";
            else if (line.startsWith("D")) device = line.slice(1).toLowerCase();
            else if (line.startsWith("i") && device === "0x" + target.dev.toString(16) && line.slice(1) === String(target.ino)) total += 1;
          }
          return total;
        }
        let total = 0;
        for (const name of fs.readdirSync("/proc/self/fd")) {
          try {
            const value = fs.statSync("/proc/self/fd/" + name);
            if (value.dev === target.dev && value.ino === target.ino) total += 1;
          } catch {}
        }
        return total;
      }
      const rootParts = process.argv[2].slice(1).split("/");
      let parents = [addon.openFilesystemRoot()];
      for (const part of rootParts.slice(0, -1)) parents.push(addon.openChildDirectory(parents.at(-1), part));
      (() => { addon.openChildRegular(parents.at(-1), rootParts.at(-1)); })();
      for (const handle of parents.reverse()) addon.closeHandle(handle);
      for (let index = 0; index < 8; index += 1) global.gc();
      setImmediate(() => { global.gc(); process.stdout.write(String(count())); });
    `, addonPath, (() => {
      const root = physicalTempRoot();
      const file = join(root, "asset.svg");
      writeFileSync(file, "x");
      return file;
    })()], { encoding: "utf8" });
    expect(output).toBe("0");
  });

  it("releases worker-owned native handles on worker termination", async () => {
    const root = physicalTempRoot();
    const file = join(root, "asset.svg");
    writeFileSync(file, "x");
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const addon = require(workerData.addonPath);
      const parts = workerData.file.slice(1).split("/");
      const handles = [addon.openFilesystemRoot()];
      for (const part of parts.slice(0, -1)) handles.push(addon.openChildDirectory(handles.at(-1), part));
      handles.push(addon.openChildRegular(handles.at(-1), parts.at(-1)));
      parentPort.postMessage("ready");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `, { eval: true, workerData: { addonPath, file } });
    await new Promise<void>((resolvePromise, reject) => {
      worker.once("message", () => resolvePromise());
      worker.once("error", reject);
    });
    expect(matchingDescriptorCount(file)).toBe(1);
    await worker.terminate();
    expect(matchingDescriptorCount(file)).toBe(0);
  });
});
