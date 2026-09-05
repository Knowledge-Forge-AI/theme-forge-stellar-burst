import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, relative } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildProject,
  bundleProject,
  checkProject,
  checkWorkspace,
  executeAssetEdit,
  formatProject,
  getDirectorySnapshotCapability,
  importProject,
  installProject,
  listProject,
  listWorkspace,
  migrateProject,
  parseAssetTomlV2,
  parseSourceMap,
  planAssetEdit,
  planShard,
  previewProject,
  previewWorkspace,
  reconcileProject,
  serializeShardManifest,
  serializeSvgV2,
} from "../src/index.js";
import { makeTempDir, readRepoFile, repoPath, unwrap } from "./helpers.js";

const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    if (client.child.exitCode === null) client.child.kill();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function temp(): string {
  const root = realpathSync(makeTempDir("tfsb-v04-integrated-"));
  roots.push(root);
  return root;
}

function canonicalSvg(): string {
  const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml")));
  return unwrap(serializeSvgV2(asset.svg));
}

function sourceMap(): string {
  return `schema_version = 1
source_root = "."

[[collection]]
id = "icons"
name = "Integrated icons"
root = "."
identity = "basename"
prefix = ""
include_paths = []
include_trees = ["icons"]
exclude_paths = []
exclude_trees = []
`;
}

function workspaceManifest(): string {
  return `schema_version = 1
id = "integrated"
name = "Integrated workspace"

[[project]]
id = "archive"
path = "projects/archive"
collections = ["legacy"]

[[project]]
id = "directory"
path = "projects/directory"
collections = ["icons"]

[[project]]
id = "shard"
path = "projects/shard"
collections = ["icons"]

[[project]]
id = "edited"
path = "projects/edited"
collections = ["legacy"]
`;
}

async function textTree(root: string, prefix = ""): Promise<string> {
  const values: string[] = [];
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) values.push(await textTree(root, name));
    else if (!name.endsWith(".zip")) values.push(await readFile(join(root, name), "utf8"));
  }
  return values.join("\n");
}

class Client {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: unknown[] = [];
  stderr = "";
  readonly #waiters: (() => void)[] = [];

  constructor() {
    this.child = spawn(process.execPath, [repoPath("dist/service-protocol/server-cli.js")], { stdio: "pipe" });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.messages.push(JSON.parse(line));
      this.#waiters.splice(0).forEach((done) => done());
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    clients.push(this);
  }

  send(value: unknown): void { this.child.stdin.write(`${JSON.stringify(value)}\n`); }

  async response(id: string): Promise<any> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex((value) => typeof value === "object" && value !== null && "id" in value && (value as { id: unknown }).id === id);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${id}`)), Math.max(1, deadline - Date.now()));
        this.#waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    throw new Error(`Timed out waiting for ${id}`);
  }

  async call(id: string, method: string, params: Record<string, unknown>): Promise<any> {
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.response(id);
  }

  async initialize(): Promise<string> {
    const response = await this.call("initialize", "initialize", {
      protocol: "tfsb.studio",
      minVersion: "1.0",
      maxVersion: "1.0",
      client: { name: "v0.4-integrated-hardening", version: "1" },
      capabilities: { progress: false, cancellation: true },
    });
    const nonce = response.result.sessionNonce as string;
    this.send({ jsonrpc: "2.0", method: "initialized", params: { sessionNonce: nonce } });
    return nonce;
  }

  async close(nonce: string): Promise<number | null> {
    expect(await this.call("shutdown", "shutdown", { sessionNonce: nonce })).toMatchObject({ result: null });
    this.send({ jsonrpc: "2.0", method: "exit", params: {} });
    this.child.stdin.end();
    return new Promise((resolve) => this.child.once("close", resolve));
  }
}

async function apply(client: Client, nonce: string, id: string, plan: any): Promise<void> {
  expect(JSON.stringify(plan.summary)).not.toContain(nonce);
  expect(JSON.stringify(plan.summary)).not.toContain(plan.planToken);
  expect(await client.call(id, "plan.apply", {
    sessionNonce: nonce,
    planToken: plan.planToken,
    expectedPlanDigest: plan.planDigest,
  })).toMatchObject({ result: { applied: true, method: plan.method } });
}

const nativeAvailable = getDirectorySnapshotCapability(realpathSync(tmpdir())).supported;

describe.runIf(nativeAvailable)("v0.4 integrated local hardening", () => {
  it("composes archive, directory, shard, workspace, bundle, and real Studio lifecycles after all original sources are removed", { timeout: 60_000 }, async () => {
    const base = temp();
    const projects = join(base, "projects");
    const archiveRoot = join(projects, "archive");
    const directoryRoot = join(projects, "directory");
    const shardRoot = join(projects, "shard");
    const editedRoot = join(projects, "edited");
    const reimportRoot = join(projects, "reimport");
    const source = join(base, "original-directory-source");
    const shardSource = join(base, "original-shard-source");
    const archive = join(base, "original-archive.zip");
    const editedArchive = join(base, "original-edited-archive.zip");
    const normalizationMap = join(base, "original-normalization-map.toml");
    const shardManifest = join(base, "original-shard-manifest.toml");
    const workspaceFile = join(base, ".tfsb-workspace.toml");
    await mkdir(join(source, "icons"), { recursive: true });
    await mkdir(join(shardSource, "icons"), { recursive: true });
    await Promise.all([archiveRoot, directoryRoot, shardRoot, editedRoot, reimportRoot].map((root) => mkdir(root, { recursive: true })));

    const legacy = readRepoFile("test/fixtures/tftn-icon-candidate-v1/favicon.svg");
    const direct = canonicalSvg();
    const normalized = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Normalized title</title><path d="M0 0L1 1"/></svg>';
    await writeFile(join(source, "icons/direct.svg"), direct);
    await writeFile(join(source, "icons/normalized.svg"), normalized);
    await writeFile(join(source, "README.md"), "Synthetic integrated fixture terms.\n");
    await writeFile(join(source, ".tfsb-source-map.toml"), sourceMap());
    await writeFile(join(shardSource, "icons/shard.svg"), direct);
    await writeFile(join(shardSource, ".tfsb-source-map.toml"), sourceMap());
    await writeFile(normalizationMap, "schema_version = 1\n");
    await writeFile(archive, zipSync({
      "legacy.svg": Buffer.from(legacy),
      "README.md": Buffer.from("Synthetic integrated fixture terms.\n"),
    }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    await writeFile(editedArchive, zipSync({ "edited.svg": Buffer.from(legacy) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));

    await importProject({ archive, root: archiveRoot, schema: 1, recordProvenance: true, companions: ["README.md"] });
    await reconcileProject({ archive, root: archiveRoot });
    await migrateProject({ root: archiveRoot });
    await formatProject({ root: archiveRoot });

    const directoryImport = await importProject({
      source: { kind: "directory", path: source },
      root: directoryRoot,
      collections: ["icons"],
      companions: ["README.md"],
      normalize: "exact-common",
      normalizationMap,
    });
    expect(directoryImport).toMatchObject({ sourceKind: "directory", provenanceSchemaVersion: 3 });
    expect(directoryImport.normalizationLedger?.entries.map((entry) => entry.disposition)).toEqual(["direct", "normalized"]);
    expect((await reconcileProject({
      directory: source,
      root: directoryRoot,
      sourceMap: join(source, ".tfsb-source-map.toml"),
      collections: ["icons"],
      normalize: "exact-common",
      normalizationMap,
      apply: true,
    })).blocked).toBe(false);

    const map = unwrap(parseSourceMap(sourceMap()));
    const shard = unwrap(await planShard(shardSource, map, "icons", ["icons/shard.svg"]));
    await writeFile(shardManifest, serializeShardManifest(shard));
    await importProject({ source: { kind: "directory", path: shardSource }, root: shardRoot, shardManifest });

    await importProject({ archive: editedArchive, root: editedRoot, schema: 1, recordProvenance: true });
    const edit = await planAssetEdit({
      root: editedRoot,
      assetId: "edited",
      proposedToml: (await readFile(join(editedRoot, ".tfsb/assets/edited.toml"), "utf8")).replace("width = 64", "width = 63"),
    });
    await executeAssetEdit(edit);

    await writeFile(join(directoryRoot, ".tfsb/project.toml"), `schema_version = 2
name = "source-independent"

[build]
directory = "brand/dist"

[[install]]
asset = "direct"
destinations = ["installed/direct.svg"]
`);
    await buildProject(directoryRoot);
    await installProject(directoryRoot);
    expect(await checkProject(directoryRoot)).toMatchObject({ valid: true, build: { missing: [], extra: [], different: [] }, install: { missing: [], different: [] } });

    await writeFile(workspaceFile, workspaceManifest());
    const firstPage = await listWorkspace({ workspaceFile, pageSize: 2 });
    expect(firstPage.page.size).toBe(2);
    expect(firstPage.page.nextCursor).not.toBeNull();
    if (firstPage.page.nextCursor === null) throw new Error("Expected a second integrated workspace page.");
    expect((await listWorkspace({ workspaceFile, pageSize: 2, cursor: firstPage.page.nextCursor })).page.size).toBeGreaterThan(0);

    await rm(source, { recursive: true, force: true });
    await rm(shardSource, { recursive: true, force: true });
    await rm(archive, { force: true });
    await rm(editedArchive, { force: true });
    await rm(normalizationMap, { force: true });
    await rm(shardManifest, { force: true });

    expect((await listProject(directoryRoot)).assets.map((asset) => asset.id)).toEqual(["direct", "normalized"]);
    await buildProject(directoryRoot);
    await installProject(directoryRoot);
    expect(await checkProject(directoryRoot)).toMatchObject({ valid: true, build: { missing: [], extra: [], different: [] }, install: { missing: [], different: [] } });
    const bundle = await bundleProject({ root: directoryRoot, output: "source-independent.zip" });
    expect(bundle).toMatchObject({ assetCount: 2, companionCount: 1 });
    await importProject({ archive: join(directoryRoot, "source-independent.zip"), root: reimportRoot, schema: 2, manifest: true });
    expect((await listProject(reimportRoot)).assets).toHaveLength(2);
    expect((await previewProject({ root: directoryRoot })).assets).toHaveLength(2);
    expect((await checkWorkspace({ workspaceFile })).projects).toMatchObject({ total: 4, checked: 4, failed: 0 });
    expect((await previewWorkspace({ workspaceFile })).projectCount).toBe(4);

    await expect(reconcileProject({
      directory: source,
      root: directoryRoot,
      sourceMap: join(source, ".tfsb-source-map.toml"),
      collections: ["icons"],
    })).rejects.toMatchObject({ diagnostic: { code: "SOURCE_MAP_UNSAFE" } });
    await expect(reconcileProject({ archive, root: archiveRoot })).rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_READ_FAILED" } });

    const client = new Client();
    const nonce = await client.initialize();
    const opened = await client.call("project-open", "project.open", { sessionNonce: nonce, path: directoryRoot });
    const projectHandle = opened.result.projectHandle as string;
    expect(opened).toMatchObject({ result: { schemaVersion: 2, assetCount: 2 } });
    expect(await client.call("project-list", "project.list", { sessionNonce: nonce, projectHandle })).toMatchObject({ result: { assets: [{ id: "direct" }, { id: "normalized" }] } });
    const listed = await client.call("asset-list", "asset.list", { sessionNonce: nonce, scope: { kind: "project", projectHandle }, pageSize: 64 });
    if (listed.result === undefined) throw new Error(`asset.list failed: ${JSON.stringify(listed)}`);
    expect(listed.result.page.items.map((item: { assetId: string }) => item.assetId)).toEqual(["direct", "normalized"]);
    const got = await client.call("asset-get", "asset.get", { sessionNonce: nonce, scope: { kind: "project", projectHandle, assetId: "direct" } });
    expect(got.result.canonicalSvg).toContain("<svg");
    const currentToml = await readFile(join(directoryRoot, ".tfsb/assets/direct.toml"), "utf8");
    expect(await client.call("asset-validate", "asset.validate", { sessionNonce: nonce, projectHandle, assetId: "direct", toml: currentToml })).toMatchObject({ result: { valid: true } });
    expect(await client.call("asset-diff", "asset.diff", { sessionNonce: nonce, projectHandle, assetId: "direct", toml: currentToml.replace("r = 8", "r = 7") })).toMatchObject({ result: { valid: true, different: true } });
    expect(await client.call("preview-status", "preview.status", { sessionNonce: nonce, projectHandle })).toMatchObject({ result: { status: "owned-clean" } });

    const workspaceOpened = await client.call("workspace-open", "workspace.open", { sessionNonce: nonce, path: workspaceFile });
    const workspaceHandle = workspaceOpened.result.workspaceHandle as string;
    expect(await client.call("workspace-status", "workspace.status", { sessionNonce: nonce, workspaceHandle, mode: "discovery" })).toMatchObject({ result: { totalProjects: 4, loadable: 4, failed: 0 } });
    const workspaceAssets = await client.call("workspace-assets", "asset.list", { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle }, pageSize: 64 });
    expect(workspaceAssets.result.page.items.map((item: { qualifiedIdentity: string }) => item.qualifiedIdentity)).toEqual(
      [...workspaceAssets.result.page.items.map((item: { qualifiedIdentity: string }) => item.qualifiedIdentity)].sort((left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    );

    const proposedToml = currentToml.replace("r = 8", "r = 7");
    expect(proposedToml).not.toBe(currentToml);
    const editPlan = (await client.call("edit-plan", "asset.edit.plan", { sessionNonce: nonce, projectHandle, assetId: "direct", proposedToml })).result;
    await apply(client, nonce, "edit-apply", editPlan);
    for (const [method, id] of [["project.fmt.plan", "fmt"], ["project.build.plan", "build"], ["project.install.plan", "install"], ["preview.plan", "preview"]] as const) {
      const plan = (await client.call(`${id}-plan`, method, { sessionNonce: nonce, projectHandle })).result;
      await apply(client, nonce, `${id}-apply`, plan);
    }
    expect(await client.call("missing-source", "source.open", { sessionNonce: nonce, path: source })).toMatchObject({ error: { data: { code: "ROOT_INVALID" } } });
    expect(await client.close(nonce)).toBe(0);
    expect(client.stderr).toBe("");

    const publicResults = [
      ["workspace domain page", firstPage],
      ["project service list", listed.result],
      ["project service get", got.result],
      ["workspace service page", workspaceAssets.result],
    ] as const;
    const publicEvidence = JSON.stringify(Object.fromEntries(publicResults));
    const generatedText = await textTree(base);
    const bundleBytes = await readFile(join(directoryRoot, "source-independent.zip"));
    for (const [label, privateValue] of [["base", base], ["directory source", source], ["shard source", shardSource], ["archive", archive], ["edited archive", editedArchive], ["normalization map", normalizationMap], ["shard manifest", shardManifest], ["home", homedir()]] as const) {
      for (const [resultLabel, result] of publicResults) expect(JSON.stringify(result).includes(privateValue), `${label} leaked through ${resultLabel}`).toBe(false);
      expect(generatedText.includes(privateValue), `${label} leaked through generated output`).toBe(false);
      expect(bundleBytes.includes(Buffer.from(privateValue)), `${label} leaked through bundle bytes`).toBe(false);
    }
    expect(publicEvidence).not.toMatch(/"(?:fd|inode|ino|dev)"\s*:/);
    expect(relative(base, directoryRoot)).toBe("projects/directory");
  });

  it("disposes an unconsumed authentic plan on service EOF without canonical or transaction residue", { timeout: 15_000 }, async () => {
    const base = temp();
    const root = join(base, "project");
    const archive = join(base, "source.zip");
    await mkdir(root);
    await writeFile(archive, zipSync({
      "asset.svg": Buffer.from(readRepoFile("test/fixtures/tftn-icon-candidate-v1/favicon.svg")),
    }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    await importProject({ archive, root, schema: 1, recordProvenance: true });
    const before = await readFile(join(root, ".tfsb/assets/asset.toml"), "utf8");

    const client = new Client();
    const nonce = await client.initialize();
    const opened = await client.call("eof-open", "project.open", { sessionNonce: nonce, path: root });
    const projectHandle = opened.result.projectHandle as string;
    const proposedToml = before.replace("width = 64", "width = 63");
    expect(proposedToml).not.toBe(before);
    const planned = await client.call("eof-plan", "asset.edit.plan", { sessionNonce: nonce, projectHandle, assetId: "asset", proposedToml });
    expect(planned.result.planToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(planned.result.summary)).not.toContain(base);

    client.child.stdin.end();
    expect(await new Promise<number | null>((resolve) => client.child.once("close", resolve))).toBe(0);
    expect(await readFile(join(root, ".tfsb/assets/asset.toml"), "utf8")).toBe(before);
    expect((await readdir(root)).filter((name) => /^\.tfsb(?:\.lock|-stage-|-backup-)/u.test(name))).toEqual([]);
    expect(client.stderr).toBe("");
  });
});
