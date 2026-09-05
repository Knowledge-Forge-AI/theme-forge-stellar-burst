import { mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { getDirectorySnapshotCapability, parseAssetTomlV2, serializeSvgV2 } from "../src/index.js";
import { runCli } from "../src/cli.js";
import { makeTempDir, readRepoFile, unwrap } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function temp(): string { const value = realpathSync(makeTempDir("tfsb-cli-directory-")); roots.push(value); return value; }
function canonicalSvg(): string { const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml"))); return unwrap(serializeSvgV2(asset.svg)); }

async function fixture() {
  const base = temp(); const source = join(base, "source"); const root = join(base, "project");
  await mkdir(join(source, "icons"), { recursive: true }); await mkdir(root);
  await writeFile(join(source, "icons", "cli.svg"), canonicalSvg());
  await writeFile(join(source, ".tfsb-source-map.toml"), 'schema_version = 1\nsource_root = "."\n\n[[collection]]\nid = "icons"\nname = "Icons"\nroot = "."\nidentity = "basename"\nprefix = ""\ninclude_paths = []\ninclude_trees = ["icons"]\nexclude_paths = []\nexclude_trees = []\n');
  return { base, source, root };
}

const nativeAvailable = getDirectorySnapshotCapability(realpathSync(tmpdir())).supported;

describe.runIf(nativeAvailable)("directory import CLI", () => {
  it("renders bounded directory facts in human output", async () => {
    const value = await fixture(); let stdout = ""; let stderr = "";
    expect(await runCli(["import", value.source, "--root", value.root, "--collection", "icons"], value.base, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } })).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Imported\nInput: directory\n");
    expect(stdout).toContain("Source map: .tfsb-source-map.toml (sha256:");
    expect(stdout).toContain("Collections: icons\nSelected assets: 1\nCompanions: 0\nSchema: 2\nProvenance: schema 3\nNormalization: direct\n");
    expect(stdout).not.toContain(value.source);

    let dryStdout = "";
    const dryRoot = join(value.base, "dry-project");
    await mkdir(dryRoot);
    expect(await runCli(["import", value.source, "--root", dryRoot, "--collection", "icons", "--dry-run"], value.base, { stdout: (text) => { dryStdout += text; }, stderr: () => undefined })).toBe(0);
    expect(dryStdout).toContain("Import dry-run\nInput: directory\n");
  });

  it("emits one deterministic JSON envelope without absolute source paths", async () => {
    const value = await fixture(); let stdout = ""; let stderr = "";
    expect(await runCli(["import", value.source, "--root", value.root, "--collection", "icons", "--dry-run", "--json"], value.base, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } })).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, command: "import", status: "ok", exitCode: 0, data: { input: { kind: "directory" }, schemaVersion: 2, provenanceSchemaVersion: 3, collections: ["icons"], assetCount: 1, companionCount: 0 } });
    expect(stdout).not.toContain(value.source);
    expect(stdout.match(/"command"/g)).toHaveLength(1);
  });

  it("reports archive input kind while keeping archive import behavior available", async () => {
    const value = await fixture(); const archive = join(value.base, "source.zip");
    await writeFile(archive, zipSync({ "cli.svg": Buffer.from(canonicalSvg()) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    let stdout = "";
    expect(await runCli(["import", archive, "--root", value.root, "--record-provenance", "--json"], value.base, { stdout: (text) => { stdout += text; }, stderr: () => undefined })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ command: "import", data: { input: { kind: "archive" }, schemaVersion: 2, assetCount: 1 } });
  });

  it("rejects directory-only conflicts as usage errors and fails a missing shard manifest closed", async () => {
    for (const args of [["--schema", "1"], ["--manifest"]]) {
      const value = await fixture(); let stderr = "";
      expect(await runCli(["import", value.source, "--root", value.root, "--collection", "icons", ...args], value.base, { stdout: () => undefined, stderr: (text) => { stderr += text; } })).toBe(1);
      expect(stderr).toContain("USAGE_ERROR");
    }
    const value = await fixture(); let stderr = "";
    expect(await runCli(["import", value.source, "--root", value.root, "--collection", "icons", "--shard-manifest", "missing.toml"], value.base, { stdout: () => undefined, stderr: (text) => { stderr += text; } })).toBe(1);
    expect(stderr).toContain("SHARD_MANIFEST_UNSAFE");
  });
});
