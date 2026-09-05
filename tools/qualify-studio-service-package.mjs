#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tfsb-packed-service-")));
const packageRoot = join("node_modules", "@knowledge-forge-ai", "theme-forge-stellar-burst");
const artifact = process.platform === "linux" ? "linux-x64-gnu" : `darwin-${process.arch}`;

/** @param {string} executable @param {string[]} args @param {string} cwd */
function command(executable, args, cwd) {
  return execFileSync(executable, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {string} root @param {string} [prefix] @returns {string[]} */
function treeInventory(root, prefix = "") {
  /** @type {string[]} */
  const values = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) values.push(...treeInventory(root, name));
    else values.push(`${name}:${statSync(join(root, name)).size}`);
  }
  return values;
}

/** @param {string} id */
function asset(id) {
  return `schema_version = 1\nid = ${JSON.stringify(id)}\nfilename = ${JSON.stringify(`${id}.svg`)}\n\n[canvas]\nview_box = "0 0 10 10"\n\n[accessibility]\ntitle = "Packed"\ntitle_id = "title"\ndescription = "Packed service."\ndescription_id = "description"\n\n[[elements]]\ntype = "path"\nd = "M 0 0 H 10 V 10 Z"\n`;
}

/** @param {string} root */
function fixture(root) {
  const project = join(root, "project"); mkdirSync(join(project, ".tfsb/assets"), { recursive: true });
  writeFileSync(join(project, ".tfsb/project.toml"), 'schema_version = 1\nname = "Packed service"\n\n[build]\ndirectory = "dist"\n\n[[install]]\nasset = "alpha"\ndestinations = ["installed/alpha.svg"]\n');
  writeFileSync(join(project, ".tfsb/assets/alpha.toml"), asset("alpha"));
  writeFileSync(join(project, ".tfsb/assets/beta.toml"), asset("beta"));
  const workspace = join(root, ".tfsb-workspace.toml");
  writeFileSync(workspace, 'schema_version = 1\nid = "packed"\nname = "Packed"\n\n[[project]]\nid = "project"\npath = "project"\ncollections = ["icons"]\n');
  const svg = readFileSync(join(repositoryRoot, "docs/examples/v0.3/lucide-consumer-labelled.svg"), "utf8");
  const source = join(root, "source"); mkdirSync(join(source, "icons"), { recursive: true }); writeFileSync(join(source, "icons/packed.svg"), svg);
  const sourceMap = join(source, ".tfsb-source-map.toml");
  writeFileSync(sourceMap, 'schema_version = 1\nsource_root = "."\n\n[[collection]]\nid = "icons"\nname = "Icons"\nroot = "."\nidentity = "basename"\nprefix = ""\ninclude_paths = []\ninclude_trees = ["icons"]\nexclude_paths = []\nexclude_trees = []\n');
  const normalizationMap = join(root, "normalization-map.toml");
  const shardManifest = join(root, "shard-manifest.toml");
  const shardPaths = join(root, "shard-paths.txt");
  writeFileSync(normalizationMap, readFileSync(join(repositoryRoot, "docs/examples/v0.3/normalization-map-schema-1.toml")));
  writeFileSync(shardPaths, "icons/packed.svg\n");
  writeFileSync(shardManifest, `schema_version = 1
collection_id = "icons"
source_map_basis = "tfsb-source-map-v1"
source_map_digest = "sha256:${"a".repeat(64)}"
source_snapshot_basis = "tfsb-directory-snapshot-v1"
source_snapshot_digest = "sha256:${"b".repeat(64)}"
membership_basis = "tfsb-shard-membership-v1"
membership_digest = "sha256:1df182c94f1a9e2341032520d42e872163a7d9114600cc8908298a2fcf3c5050"
asset_count = 2
selected_bytes = 8
profile = "tfsb-svg-common-v0.3"
directly_importable = 1
normalization_required = 1
unsupported = 0
unsafe = 0

[[asset]]
source_path = "a.svg"
asset_id = "a"
source_digest = "sha256:${"a".repeat(64)}"
source_bytes = 3

[[asset]]
source_path = "b.svg"
asset_id = "b"
source_digest = "sha256:${"b".repeat(64)}"
source_bytes = 5
`);
  const archive = join(root, "source.zip"); writeFileSync(archive, zipSync({ "packed.svg": new TextEncoder().encode(svg) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
  return { project, workspace, source, sourceMap, normalizationMap, shardManifest, shardPaths, archive };
}

/** @param {string} consumer @param {string} fixtureRoot */
function probeCli(consumer, fixtureRoot) {
  const paths = fixture(fixtureRoot);
  const cliSvg = readFileSync(join(repositoryRoot, "test/fixtures/tftn-icon-candidate-v1/theme-forge-terminal-nova-mark.svg"));
  writeFileSync(paths.archive, zipSync({ "packed.svg": cliSvg }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
  const project = join(fixtureRoot, "cli-project"); mkdirSync(project);
  const reimport = join(fixtureRoot, "cli-reimport"); mkdirSync(reimport);
  const bin = join(consumer, "node_modules/.bin/tfsb");
  /** @type {string[]} */
  const output = [];
  /** @param {string[]} args */
  const run = (args) => output.push(command(bin, args, consumer));

  const version = command(bin, ["--version"], consumer);
  if (version.trim() !== "0.4.0") throw new Error("Packed CLI version mismatch.");
  output.push(version);
  run(["import", paths.archive, "--root", project, "--schema", "1", "--record-provenance"]);
  const projectToml = join(project, ".tfsb/project.toml");
  writeFileSync(projectToml, `${readFileSync(projectToml, "utf8")}\n[[install]]\nasset = "packed"\ndestinations = ["installed/packed.svg"]\n`);
  run(["fmt", "--root", project]);
  run(["migrate", "--root", project]);
  run(["reconcile", paths.archive, "--root", project]);
  run(["build", "--root", project]);
  run(["install", "--root", project]);
  run(["check", "--root", project]);
  run(["list", "--root", project, "--json"]);
  run(["diff", "--root", project, "--build", "--json"]);
  run(["diff", "--root", project, "--install", "--json"]);
  run(["preview", "--root", project, "--json"]);
  run(["bundle", "--root", project, "--output", "packed.zip", "--json"]);
  run(["import", join(project, "packed.zip"), "--root", reimport, "--schema", "2", "--manifest"]);
  run(["build", "--root", reimport]);
  run(["install", "--root", reimport]);
  run(["check", "--root", reimport]);
  run(["list", "--root", reimport, "--json"]);
  run(["preview", "--root", reimport, "--json"]);

  if (!existsSync(join(project, "brand/dist/packed.svg")) || !existsSync(join(project, "installed/packed.svg")) || !existsSync(join(project, ".tfsb-preview/index.html"))) throw new Error("Packed CLI lifecycle did not produce project outputs.");
  if (!existsSync(join(reimport, "brand/dist/packed.svg")) || !existsSync(join(reimport, ".tfsb-preview/index.html"))) throw new Error("Packed CLI bundle re-import did not produce project outputs.");
  if (output.some((value) => value.includes(fixtureRoot))) throw new Error("Packed CLI lifecycle leaked its fixture root.");
  return {
    installedBinary: true,
    commands: ["version", "import", "fmt", "migrate", "reconcile", "build", "install", "check", "list", "diff-build", "diff-install", "preview", "bundle", "bundle-reimport"],
    projectOutputs: true,
    reimportOutputs: true,
    privatePathAbsent: true,
  };
}

class Client {
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */ child;
  /** @type {any[]} */ messages;
  /** @type {Array<() => void>} */ waiters;
  /** @type {string} */ stderr;
  /** @type {any[]} */ allMessages;
  /** @param {string} bin @param {string} cwd */
  constructor(bin, cwd) {
    this.child = spawn(bin, [], { cwd, stdio: "pipe" }); this.messages = []; this.allMessages = []; this.waiters = []; this.stderr = "";
    createInterface({ input: this.child.stdout }).on("line", (line) => { const parsed = JSON.parse(line); this.messages.push(parsed); this.allMessages.push(parsed); this.waiters.splice(0).forEach((done) => done()); });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
  }
  /** @param {unknown} value */
  send(value) { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  /** @param {string} id @returns {Promise<any>} */
  async response(id) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex((value) => value?.id === id);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Packed service response timeout: ${id}`)), deadline - Date.now()); this.waiters.push(() => { clearTimeout(timer); resolve(undefined); }); });
    }
    throw new Error(`Packed service response timeout: ${id}`);
  }
  /** @param {string} id @param {string} method @param {Record<string, unknown>} params @returns {Promise<any>} */
  async call(id, method, params) { this.send({ jsonrpc: "2.0", id, method, params }); return this.response(id); }
  /** @returns {Promise<{nonce: string, initialized: any}>} */
  async initialize() {
    const initialized = requireResult(await this.call("init", "initialize", { protocol: "tfsb.studio", minVersion: "1.0", maxVersion: "1.0", client: { name: "packed-qualification", version: "1" }, capabilities: { progress: true, cancellation: true } }), "init");
    this.send({ jsonrpc: "2.0", method: "initialized", params: { sessionNonce: initialized.sessionNonce } });
    return { nonce: initialized.sessionNonce, initialized };
  }
  /** @param {string} nonce */
  async shutdown(nonce) {
    requireResult(await this.call("shutdown", "shutdown", { sessionNonce: nonce }), "shutdown");
    this.send({ jsonrpc: "2.0", method: "exit", params: {} }); this.child.stdin.end();
    const exit = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Packed service exit timeout.")), 10_000); this.child.once("close", (code) => { clearTimeout(timer); resolve(code); }); });
    if (exit !== 0 || this.stderr !== "") throw new Error("Packed service did not exit cleanly.");
  }
}

/** @param {any} response @param {string} id @returns {any} */
function requireResult(response, id) {
  if (response?.error !== undefined || response?.result === undefined) throw new Error(`Packed service request failed: ${id}: ${JSON.stringify(response?.error?.data?.code)}`);
  return response.result;
}

/** @param {any} response @param {string} code @param {string} id */
function requireError(response, code, id) {
  if (response?.error?.data?.code !== code) throw new Error(`Packed service ${id} expected ${code}, received ${JSON.stringify(response?.error?.data?.code)}.`);
  return response.error;
}

/** @param {any} response @param {string} method @param {string} id */
function requirePlan(response, method, id) {
  const plan = requireResult(response, id);
  if (plan.method !== method || !/^[A-Za-z0-9_-]{43}$/.test(plan.planToken) || !/^sha256:[0-9a-f]{64}$/.test(plan.planDigest) || plan.expiresInMs !== 600_000) {
    throw new Error(`Packed service ${id} returned an invalid plan wrapper.`);
  }
  return plan;
}

/** @param {Client} client @param {string} nonce @param {string} id @param {any} plan */
async function applyPlan(client, nonce, id, plan) {
  const result = requireResult(await client.call(id, "plan.apply", { sessionNonce: nonce, planToken: plan.planToken, expectedPlanDigest: plan.planDigest }), id);
  if (result.applied !== true || result.method !== plan.method) throw new Error(`Packed service ${id} apply mismatch.`);
  return result;
}

/** @param {string} consumer @param {string} fixtureRoot */
async function probeService(consumer, fixtureRoot) {
  const paths = fixture(fixtureRoot);
  const archiveTarget = join(fixtureRoot, "archive-target"); mkdirSync(archiveTarget);
  const directoryTarget = join(fixtureRoot, "directory-target"); mkdirSync(directoryTarget);
  const bin = join(consumer, "node_modules/.bin/tfsb-studio-service");
  const client = new Client(bin, consumer);
  const { nonce, initialized } = await client.initialize();
  const capabilities = initialized.capabilities;
  if (capabilities.methods.mutationPlans !== true || capabilities.methods.planApply !== true) throw new Error("Packed service did not advertise mutation authority.");
  const expectedLimits = { maxActivePlans: 4, maxRetainedPlanBytes: 201326592, maxRetainedNativeSnapshotPlans: 1, planTtlMs: 600000, maxConcurrentApplies: 1 };
  for (const [name, value] of Object.entries(expectedLimits)) if (capabilities.limits[name] !== value) throw new Error(`Packed service limit mismatch: ${name}.`);

  const projectHandle = requireResult(await client.call("project-open", "project.open", { sessionNonce: nonce, path: paths.project }), "project-open").projectHandle;
  if (requireResult(await client.call("project-list", "project.list", { sessionNonce: nonce, projectHandle }), "project-list").assets.length !== 2) throw new Error("Packed project.list mismatch.");
  const originalToml = readFileSync(join(paths.project, ".tfsb/assets/alpha.toml"), "utf8");
  if (requireResult(await client.call("asset-get", "asset.get", { sessionNonce: nonce, scope: { kind: "project", projectHandle, assetId: "alpha" } }), "asset-get").assetId !== "alpha") throw new Error("Packed asset.get mismatch.");

  const archiveSourceHandle = requireResult(await client.call("archive-open", "source.open", { sessionNonce: nonce, path: paths.archive }), "archive-open").sourceHandle;
  const directorySourceHandle = requireResult(await client.call("directory-open", "source.open", { sessionNonce: nonce, path: paths.source }), "directory-open").sourceHandle;
  if (requireResult(await client.call("archive-analyze", "source.analyze", { sessionNonce: nonce, sourceHandle: archiveSourceHandle, includeDetails: false, pageSize: 1 }), "archive-analyze").sourceKind !== "archive") throw new Error("Packed archive analysis mismatch.");
  if (requireResult(await client.call("directory-analyze", "source.analyze", { sessionNonce: nonce, sourceHandle: directorySourceHandle, includeDetails: false, pageSize: 1 }), "directory-analyze").sourceKind !== "directory") throw new Error("Packed directory analysis mismatch.");
  const sourceMapHandle = requireResult(await client.call("source-map-open", "source.open", { sessionNonce: nonce, path: paths.sourceMap, purpose: "source-map" }), "source-map-open").sourceHandle;
  requireResult(await client.call("normalization-map-open", "source.open", { sessionNonce: nonce, path: paths.normalizationMap, purpose: "normalization-map" }), "normalization-map-open");
  rmSync(paths.shardManifest);
  command(join(consumer, "node_modules/.bin/tfsb"), ["shard", paths.source, "--source-map", paths.sourceMap, "--collection", "icons", "--paths-file", paths.shardPaths, "--manifest-output", paths.shardManifest], consumer);
  const shardManifestHandle = requireResult(await client.call("shard-manifest-open", "source.open", { sessionNonce: nonce, path: paths.shardManifest, purpose: "shard-manifest" }), "shard-manifest-open").sourceHandle;

  const editedToml = originalToml.replace('title = "Packed"', 'title = "Edited packed"');
  const editPlan = requirePlan(await client.call("edit-plan", "asset.edit.plan", { sessionNonce: nonce, projectHandle, assetId: "alpha", proposedToml: editedToml }), "asset.edit.plan", "edit-plan");
  const wrongDigest = `sha256:${"0".repeat(64)}`;
  const mismatch = await client.call("edit-digest-mismatch", "plan.apply", { sessionNonce: nonce, planToken: editPlan.planToken, expectedPlanDigest: wrongDigest });
  requireError(mismatch, "PLAN_DIGEST_MISMATCH", "edit-digest-mismatch");
  if (JSON.stringify(mismatch).includes(editPlan.planToken)) throw new Error("Packed digest error leaked a plan token.");
  await applyPlan(client, nonce, "edit-apply", editPlan);
  if (!readFileSync(join(paths.project, ".tfsb/assets/alpha.toml"), "utf8").includes('title = "Edited packed"')) throw new Error("Packed asset edit did not promote.");
  requireError(await client.call("edit-reuse", "plan.apply", { sessionNonce: nonce, planToken: editPlan.planToken, expectedPlanDigest: editPlan.planDigest }), "PLAN_TOKEN_INVALID", "edit-reuse");
  const discardPlan = requirePlan(await client.call("discard-plan", "asset.edit.plan", { sessionNonce: nonce, projectHandle, assetId: "alpha", proposedToml: editedToml.replace("Edited packed", "Discarded packed") }), "asset.edit.plan", "discard-plan");
  if (requireResult(await client.call("discard", "plan.discard", { sessionNonce: nonce, planToken: discardPlan.planToken }), "discard").discarded !== true) throw new Error("Packed plan discard mismatch.");

  /** @type {Array<[string, string, Record<string, unknown>]>} */
  const projectPlans = [
    ["project.fmt.plan", "fmt", {}],
    ["project.build.plan", "build", {}],
    ["project.install.plan", "install", {}],
    ["preview.plan", "preview", {}],
  ];
  for (const [method, id, extra] of projectPlans) {
    const plan = requirePlan(await client.call(`${id}-plan`, method, { sessionNonce: nonce, projectHandle, ...extra }), method, `${id}-plan`);
    await applyPlan(client, nonce, `${id}-apply`, plan);
  }
  if (!existsSync(join(paths.project, "dist/alpha.svg")) || !existsSync(join(paths.project, "installed/alpha.svg")) || !existsSync(join(paths.project, ".tfsb-preview/index.html"))) throw new Error("Packed project-owned outputs were not produced.");

  const archiveTargetHandle = requireResult(await client.call("archive-target-open", "project.open", { sessionNonce: nonce, path: archiveTarget, mode: "import-target" }), "archive-target-open").projectHandle;
  requireError(await client.call("archive-target-read", "project.list", { sessionNonce: nonce, projectHandle: archiveTargetHandle }), "ROOT_HANDLE_INVALID", "archive-target-read");
  const archiveImportPlan = requirePlan(await client.call("archive-import-plan", "project.import.plan", { sessionNonce: nonce, projectHandle: archiveTargetHandle, sourceHandle: archiveSourceHandle, schemaVersion: 2 }), "project.import.plan", "archive-import-plan");
  await applyPlan(client, nonce, "archive-import-apply", archiveImportPlan);
  const archiveProjectHandle = requireResult(await client.call("archive-project-open", "project.open", { sessionNonce: nonce, path: archiveTarget }), "archive-project-open").projectHandle;
  const archiveReconcilePlan = requirePlan(await client.call("archive-reconcile-plan", "project.reconcile.plan", { sessionNonce: nonce, projectHandle: archiveProjectHandle, sourceHandle: archiveSourceHandle }), "project.reconcile.plan", "archive-reconcile-plan");
  await applyPlan(client, nonce, "archive-reconcile-apply", archiveReconcilePlan);

  const directoryTargetHandle = requireResult(await client.call("directory-target-open", "project.open", { sessionNonce: nonce, path: directoryTarget, mode: "import-target" }), "directory-target-open").projectHandle;
  const directoryImportPlan = requirePlan(await client.call("directory-import-plan", "project.import.plan", {
    sessionNonce: nonce,
    projectHandle: directoryTargetHandle,
    sourceHandle: directorySourceHandle,
    schemaVersion: 2,
    collections: ["icons"],
    sourceMapAuthority: { kind: "handle", sourceMapHandle },
    shardManifestHandle,
  }), "project.import.plan", "directory-import-plan");
  if (directoryImportPlan.summary.assetCount !== 1) throw new Error("Packed shard-backed service import selected an unexpected asset count.");
  await applyPlan(client, nonce, "directory-import-apply", directoryImportPlan);
  if (!existsSync(join(directoryTarget, ".tfsb/assets/packed.toml"))) throw new Error("Packed shard-backed service import did not materialize the selected asset.");
  const directoryProjectHandle = requireResult(await client.call("directory-project-open", "project.open", { sessionNonce: nonce, path: directoryTarget }), "directory-project-open").projectHandle;
  const directoryReconcilePlan = requirePlan(await client.call("directory-reconcile-plan", "project.reconcile.plan", { sessionNonce: nonce, projectHandle: directoryProjectHandle, sourceHandle: directorySourceHandle, collections: ["icons"], sourceMapAuthority: { kind: "handle", sourceMapHandle } }), "project.reconcile.plan", "directory-reconcile-plan");
  await applyPlan(client, nonce, "directory-reconcile-apply", directoryReconcilePlan);

  const stalePlan = requirePlan(await client.call("stale-plan", "asset.edit.plan", { sessionNonce: nonce, projectHandle, assetId: "beta", proposedToml: asset("beta").replace('title = "Packed"', 'title = "Stale packed"') }), "asset.edit.plan", "stale-plan");
  writeFileSync(join(paths.project, ".tfsb/assets/beta.toml"), asset("beta").replace('title = "Packed"', 'title = "External drift"'));
  requireError(await client.call("stale-apply", "plan.apply", { sessionNonce: nonce, planToken: stalePlan.planToken, expectedPlanDigest: stalePlan.planDigest }), "PLAN_STALE", "stale-apply");
  requireError(await client.call("stale-reuse", "plan.apply", { sessionNonce: nonce, planToken: stalePlan.planToken, expectedPlanDigest: stalePlan.planDigest }), "PLAN_TOKEN_INVALID", "stale-reuse");
  const migratePlan = requirePlan(await client.call("migrate-plan", "project.migrate.plan", { sessionNonce: nonce, projectHandle, targetSchemaVersion: 2 }), "project.migrate.plan", "migrate-plan");
  await applyPlan(client, nonce, "migrate-apply", migratePlan);

  const protocolOutput = JSON.stringify(client.allMessages);
  for (const privateValue of [fixtureRoot, paths.project, paths.archive, paths.source, Buffer.from(readFileSync(paths.archive)).toString("base64")]) if (protocolOutput.includes(privateValue)) throw new Error("Packed service leaked private authority data.");
  await client.shutdown(nonce);
  return { methodsApplied: 10, auxiliaryPurposes: 3, shardBackedImport: true, digestMismatchPreservedToken: true, staleConsumedToken: true, cleanExit: true };
}

/** @param {string} consumer @param {string} fixtureRoot @param {"missing" | "corrupt"} condition */
async function probeDegradedNative(consumer, fixtureRoot, condition) {
  const paths = fixture(fixtureRoot);
  const archiveTarget = join(fixtureRoot, "archive-target"); mkdirSync(archiveTarget);
  const directoryTarget = join(fixtureRoot, "directory-target"); mkdirSync(directoryTarget);
  const packageTreeBefore = treeInventory(join(consumer, packageRoot));
  command(process.execPath, ["--input-type=module", "-e", `
    const fs = await import("node:fs");
    const pkg = await import("@knowledge-forge-ai/theme-forge-stellar-burst");
    const parsed = pkg.parseSourceMap(fs.readFileSync(${JSON.stringify(paths.sourceMap)}, "utf8"));
    if (!parsed.ok) throw new Error("Packed degraded source map parse failed.");
    const planned = await pkg.planShard(${JSON.stringify(paths.source)}, parsed.value, "icons", ["icons/packed.svg"]);
    if (!planned.ok || planned.value.assets.length !== 1) throw new Error("Packed degraded shard planning failed.");
  `], consumer);
  const client = new Client(join(consumer, "node_modules/.bin/tfsb-studio-service"), consumer);
  const { nonce } = await client.initialize();
  const projectHandle = requireResult(await client.call("project-open", "project.open", { sessionNonce: nonce, path: paths.project }), "project-open").projectHandle;
  if (requireResult(await client.call("project-list", "project.list", { sessionNonce: nonce, projectHandle }), "project-list").assets.length !== 2) throw new Error(`Packed ${condition} native read surface failed.`);
  const workspaceHandle = requireResult(await client.call("workspace-open", "workspace.open", { sessionNonce: nonce, path: paths.workspace }), "workspace-open").workspaceHandle;
  const workspaceStatus = requireResult(await client.call("workspace-status", "workspace.status", { sessionNonce: nonce, workspaceHandle, mode: "discovery" }), "workspace-status");
  if (workspaceStatus.loadable !== 1 || requireResult(await client.call("workspace-list", "asset.list", { sessionNonce: nonce, scope: { kind: "workspace", workspaceHandle }, pageSize: 64 }), "workspace-list").page.count !== 2) throw new Error(`Packed ${condition} native workspace service surface failed.`);

  const archiveSourceHandle = requireResult(await client.call("archive-open", "source.open", { sessionNonce: nonce, path: paths.archive }), "archive-open").sourceHandle;
  const archiveTargetHandle = requireResult(await client.call("archive-target-open", "project.open", { sessionNonce: nonce, path: archiveTarget, mode: "import-target" }), "archive-target-open").projectHandle;
  const archivePlan = requirePlan(await client.call("archive-import-plan", "project.import.plan", { sessionNonce: nonce, projectHandle: archiveTargetHandle, sourceHandle: archiveSourceHandle, schemaVersion: 2 }), "project.import.plan", "archive-import-plan");
  await applyPlan(client, nonce, "archive-import-apply", archivePlan);
  if (!existsSync(join(archiveTarget, ".tfsb/project.toml"))) throw new Error(`Packed ${condition} native archive mutation failed.`);

  const directorySourceHandle = requireResult(await client.call("directory-open", "source.open", { sessionNonce: nonce, path: paths.source }), "directory-open").sourceHandle;
  if (requireResult(await client.call("directory-analyze", "source.analyze", { sessionNonce: nonce, sourceHandle: directorySourceHandle, includeDetails: false, pageSize: 64 }), "directory-analyze").sourceKind !== "directory") throw new Error(`Packed ${condition} native directory analysis failed.`);
  const sourceMapHandle = requireResult(await client.call("source-map-open", "source.open", { sessionNonce: nonce, path: paths.sourceMap, purpose: "source-map" }), "source-map-open").sourceHandle;
  const directoryTargetHandle = requireResult(await client.call("directory-target-open", "project.open", { sessionNonce: nonce, path: directoryTarget, mode: "import-target" }), "directory-target-open").projectHandle;
  requireError(await client.call("directory-import-plan", "project.import.plan", { sessionNonce: nonce, projectHandle: directoryTargetHandle, sourceHandle: directorySourceHandle, schemaVersion: 2, collections: ["icons"] }), "DOMAIN_OPERATION_FAILED", "directory-import-plan");
  if (existsSync(join(directoryTarget, ".tfsb"))) throw new Error(`Packed ${condition} native directory failure mutated its target.`);
  const archiveProjectHandle = requireResult(await client.call("archive-project-open", "project.open", { sessionNonce: nonce, path: archiveTarget }), "archive-project-open").projectHandle;
  requireError(await client.call("directory-reconcile-plan", "project.reconcile.plan", {
    sessionNonce: nonce,
    projectHandle: archiveProjectHandle,
    sourceHandle: directorySourceHandle,
    collections: ["icons"],
    acceptedSourceKindChange: "archive-to-directory",
    sourceMapAuthority: { kind: "handle", sourceMapHandle },
  }), "DOMAIN_OPERATION_FAILED", "directory-reconcile-plan");
  requireError(await client.call("directory-apply", "plan.apply", {
    sessionNonce: nonce,
    planToken: "A".repeat(43),
    expectedPlanDigest: `sha256:${"0".repeat(64)}`,
  }), "PLAN_TOKEN_INVALID", "directory-apply");
  const output = JSON.stringify(client.allMessages);
  for (const privateValue of [fixtureRoot, paths.source, paths.archive]) if (output.includes(privateValue)) throw new Error(`Packed ${condition} native probe leaked a path.`);
  await client.shutdown(nonce);
  if (JSON.stringify(treeInventory(join(consumer, packageRoot))) !== JSON.stringify(packageTreeBefore)) throw new Error(`Packed ${condition} native probe changed the installed package tree.`);
  return {
    publicModuleImport: true,
    serviceStartup: true,
    readSurface: true,
    workspaceService: true,
    directoryAnalysis: true,
    shardPlanning: true,
    archiveMutation: true,
    directoryImportPlanFailedClosed: true,
    directoryReconcilePlanFailedClosed: true,
    directoryApplyFailedClosed: true,
    dynamicFallbackAbsent: true,
    cleanExit: true,
  };
}

let tarball = "";
try {
  const pack = JSON.parse(command("npm", ["pack", "--json", "--pack-destination", scratch], repositoryRoot));
  tarball = join(scratch, pack[0].filename);
  /** @type {string[]} */
  const consumers = [];
  for (const name of ["consumer-one", "consumer-two"]) {
    const root = join(scratch, name); mkdirSync(root); writeFileSync(join(root, "package.json"), '{"name":"studio-consumer","private":true}\n');
    command("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball], root); consumers.push(root);
  }
  const firstConsumer = consumers[0]; const secondConsumer = consumers[1];
  if (firstConsumer === undefined || secondConsumer === undefined) throw new Error("Packed consumers were not created.");
  const cli = probeCli(firstConsumer, join(scratch, "fixture-cli"));
  const first = await probeService(firstConsumer, join(scratch, "fixture-one"));
  const second = await probeService(secondConsumer, join(scratch, "fixture-two"));
  const installedArtifact = join(secondConsumer, packageRoot, "native/directory-snapshot/prebuilds", artifact, "native-addon-posix-openat-v1.node");
  rmSync(installedArtifact); const missing = await probeDegradedNative(secondConsumer, join(scratch, "fixture-missing"), "missing");
  writeFileSync(installedArtifact, "corrupt native artifact"); const corrupt = await probeDegradedNative(secondConsumer, join(scratch, "fixture-corrupt"), "corrupt");
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, packageVersion: pack[0].version, packageEntries: pack[0].entryCount, packageBytes: pack[0].size, packageUnpackedBytes: pack[0].unpackedSize, cli, installs: [first, second], missingArtifact: missing, corruptArtifact: corrupt }, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
