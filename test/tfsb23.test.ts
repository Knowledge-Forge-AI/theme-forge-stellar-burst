import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildProject } from "../src/build.js";
import { bundleProject } from "../src/bundle.js";
import { checkProject } from "../src/check.js";
import { runCli } from "../src/cli.js";
import { diffArchive, diffBuild, diffInstall, diffProvenance } from "../src/diff.js";
import { computeAssetSemanticDigest, computePathTextDigest, PATH_DIGEST_BASIS } from "../src/digests.js";
import { DiagnosticError } from "../src/diagnostics.js";
import { executeFormat, formatProject, planFormat, type FormatPlan } from "../src/fmt.js";
import { importProject } from "../src/importer.js";
import { installProject } from "../src/install.js";
import { createJsonEnvelope, mapMachineDiagnostic, serializeJsonEnvelope } from "../src/json.js";
import { listProject } from "../src/list.js";
import { loadCanonicalProject } from "../src/project.js";
import { BUILD_RECEIPT_FILENAME, parseBuildReceipt, readBuildReceipt, serializeBuildReceipt, type BuildReceiptV2 } from "../src/receipt.js";

const FIXTURE = join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function initialized(): Promise<{ root: string; archive: string }> {
  const root = await mkdtemp(join(tmpdir(), "tfsb23-")); roots.push(root);
  const files: Record<string, Uint8Array> = {};
  for (const name of await readdir(FIXTURE)) files[name] = await readFile(join(FIXTURE, name));
  const archive = join(root, "terminal-nova.zip");
  await writeFile(archive, zipSync(files, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }));
  await importProject({ archive, root, schema: 1, recordProvenance: true });
  return { root, archive };
}

describe("TFSB23 receipts and diff baselines", () => {
  it("writes deterministic strict v3 receipts while retaining v2 ownership", async () => {
    const { root } = await initialized();
    await buildProject(root);
    const receiptPath = join(root, "brand/dist", BUILD_RECEIPT_FILENAME);
    const first = await readFile(receiptPath);
    await buildProject(root);
    expect(await readFile(receiptPath)).toEqual(first);
    const state = await readBuildReceipt(join(root, "brand/dist"));
    expect(state.status).toBe("v3");
    if (state.status !== "v3") throw new Error("Expected v3 receipt.");
    expect(state.receipt.projectPolicy).toEqual({ buildDirectory: "brand/dist", installs: [], companions: [] });
    expect(parseBuildReceipt(JSON.stringify({ ...state.receipt, unexpected: true }))).toEqual({ status: "invalid" });
    expect(parseBuildReceipt(JSON.stringify({ ...state.receipt, outputs: { ...state.receipt.outputs, "x.svg": "BAD" } }))).toEqual({ status: "invalid" });
    expect(parseBuildReceipt(JSON.stringify({
      ...state.receipt,
      projectPolicy: {
        ...state.receipt.projectPolicy,
        installs: [
          { assetId: "favicon", destinations: ["consumer/a.svg"] },
          { assetId: "favicon", destinations: ["consumer/b.svg"] },
        ],
      },
    }))).toEqual({ status: "invalid" });
    expect(parseBuildReceipt(JSON.stringify({
      ...state.receipt,
      projectPolicy: {
        ...state.receipt.projectPolicy,
        companions: [
          { file: "LICENSE.txt", destinations: ["consumer/a.txt"] },
          { file: "LICENSE.txt", destinations: ["consumer/b.txt"] },
        ],
      },
    }))).toEqual({ status: "invalid" });
    const normalized = parseBuildReceipt(JSON.stringify({
      ...state.receipt,
      projectPolicy: {
        ...state.receipt.projectPolicy,
        installs: [
          { assetId: "wordmark", destinations: ["consumer/z.svg", "consumer/a.svg"] },
          { assetId: "favicon", destinations: ["consumer/b.svg"] },
        ],
      },
    }));
    expect(normalized.status).toBe("v3");
    if (normalized.status !== "v3") throw new Error("Expected normalized v3 receipt.");
    expect(normalized.receipt.projectPolicy.installs).toEqual([
      { assetId: "favicon", destinations: ["consumer/b.svg"] },
      { assetId: "wordmark", destinations: ["consumer/a.svg", "consumer/z.svg"] },
    ]);

    const v2: BuildReceiptV2 = { kind: "tfsb-build-v2", schemaVersion: 2, toolVersion: "0.1.0", buildDirectory: state.receipt.buildDirectory, canonicalSources: state.receipt.canonicalSources, outputs: state.receipt.outputs };
    await writeFile(receiptPath, serializeBuildReceipt(v2));
    expect((await checkProject(root)).sourceChanged).toBe(false);
    await installProject(root);
    await expect(diffBuild(await loadCanonicalProject(root, "diff"))).rejects.toMatchObject({ diagnostic: { code: "BUILD_DIFF_BASELINE_UNAVAILABLE" } });
    await buildProject(root);
    expect((await readBuildReceipt(join(root, "brand/dist"))).status).toBe("v3");
  });

  it("reports clean provenance, archive, build, and install baselines read-only", async () => {
    const { root, archive } = await initialized(); await buildProject(root); await installProject(root);
    const project = await loadCanonicalProject(root, "diff");
    expect(await diffProvenance(project)).toMatchObject({ different: false });
    expect(await diffArchive(project, archive)).toMatchObject({ different: false });
    expect(await diffBuild(project)).toMatchObject({ different: false });
    expect(await diffInstall(project)).toMatchObject({ different: false });
  });

  it("classifies build source/output/policy and install destination drift", async () => {
    const { root } = await initialized();
    const projectPath = join(root, ".tfsb/project.toml");
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}\n[[install]]\nasset = "favicon"\ndestinations = ["consumer/a.svg", "consumer/b.svg"]\n`);
    await buildProject(root); await installProject(root);
    let project = await loadCanonicalProject(root, "diff");
    expect((await diffInstall(project)).different).toBe(false);
    await rm(join(root, "consumer/a.svg")); await writeFile(join(root, "consumer/b.svg"), "different");
    expect((await diffInstall(project)).destinations.map((item) => item.state)).toEqual(["missing", "byte_different"]);

    const outputs = (await readdir(join(root, "brand/dist"))).filter((name) => name.endsWith(".svg"));
    await rm(join(root, "brand/dist", outputs[0]!));
    await writeFile(join(root, "brand/dist", outputs[1]!), "different");
    await writeFile(join(root, "brand/dist/extra.svg"), "extra");
    await writeFile(projectPath, (await readFile(projectPath, "utf8")).replace("consumer/b.svg", "consumer/c.svg"));
    project = await loadCanonicalProject(root, "diff");
    const build = await diffBuild(project);
    expect(build.outputs.map((item) => item.changeType)).toEqual(expect.arrayContaining(["added", "removed", "changed"]));
    expect(build.canonicalSources.some((item) => item.path === ".tfsb/project.toml" && item.changeType === "changed")).toBe(true);
    expect(build.policyChanges.map((item) => item.kind)).toEqual(expect.arrayContaining(["asset_destination"]));
  });

  it("freezes tfsb-path-text-v1 golden vectors", () => {
    expect(PATH_DIGEST_BASIS).toBe("tfsb-path-text-v1");
    expect(computePathTextDigest("M0 0")).toBe("22b2a2e90334ff6d368080abc16b4cf7117d79260a5269a00ad9e60fbd792933");
    expect(computePathTextDigest("M 0 0 L 10 10")).toBe("2f40502ee1284158a8043b2d7a0ed9208737e4e545c9d99c3cb300c3bb60fee4");
  });

  it("reports bounded typed SVG changes without exposing full path text", async () => {
    const { root } = await initialized();
    const files: Record<string, Uint8Array> = {};
    for (const name of await readdir(FIXTURE)) files[name] = await readFile(join(FIXTURE, name));
    const favicon = Buffer.from(files["favicon.svg"]!).toString("utf8")
      .replace('width="64"', 'width="65"')
      .replace("Terminal Nova favicon", "Terminal Nova changed favicon")
      .replace("Version: 1.0", "Version: 1.1")
      .replace('x1="22"', 'x1="23"')
      .replace('stop-color="#E45A9E"', 'stop-color="#E45A9F"')
      .replace("  </defs>", '    <path id="def-extra" d="M0 0Z"/>\n  </defs>')
      .replace('<g id="favicon-six-facet-enclosure" fill="#262A33">', '<g id="favicon-six-facet-enclosure" fill="#262A34" transform="translate(1 2)">')
      .replace("  </g>", '    <path id="art-extra" d="M1 1L2 2Z"/>\n  </g>')
      .replace("M32 20\n", "M32 21\n");
    files["favicon.svg"] = Buffer.from(favicon);
    files["new-asset.svg"] = files["mark-monochrome-dark.svg"]!;
    files["README.md"] = Buffer.from("Legal companion\n");
    const archive = join(root, "changed.zip"); await writeFile(archive, zipSync(files, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }));
    const result = await diffArchive(await loadCanonicalProject(root, "diff"), archive);
    expect(result.changes.map((change) => change.category)).toEqual(expect.arrayContaining(["canvas", "accessibility", "metadata", "gradient", "gradient_stop", "definition", "artwork_element", "presentation", "transform", "path_geometry", "companion", "asset_addition_removal"]));
    const paths = result.changes.filter((change) => change.pathText !== undefined);
    expect(paths.length).toBeGreaterThan(0);
    for (const change of paths) {
      expect(Array.from(change.pathText!.beforePrefix ?? "").length).toBeLessThanOrEqual(64);
      expect(Array.from(change.pathText!.beforeSuffix ?? "").length).toBeLessThanOrEqual(64);
      expect(change).not.toHaveProperty("before"); expect(change).not.toHaveProperty("after");
    }
  });
});

describe("TFSB23 canonical formatting and JSON", () => {
  it("formats the complete canonical TOML tree without semantic or provenance drift", async () => {
    const { root } = await initialized();
    const beforeProject = await loadCanonicalProject(root, "fmt");
    const beforeDigests = beforeProject.assets.map(computeAssetSemanticDigest);
    const provenancePath = join(root, ".tfsb/provenance.json"); const provenance = await readFile(provenancePath);
    const projectPath = join(root, ".tfsb/project.toml"); const assetPath = join(root, ".tfsb/assets", `${beforeProject.assets[0]!.id}.toml`);
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}# removed by fmt\n`);
    await writeFile(assetPath, `${await readFile(assetPath, "utf8")}# removed by fmt\n`);
    await bundleProject({ root, output: "bundle-before.zip" });
    await buildProject(root);
    const receiptBefore = await readFile(join(root, "brand/dist", BUILD_RECEIPT_FILENAME));
    expect(await formatProject({ root, check: true })).toMatchObject({ changed: true, applied: false, paths: [`.tfsb/assets/${beforeProject.assets[0]!.id}.toml`, ".tfsb/project.toml"] });
    const plan = await planFormat(root);
    await expect(executeFormat({ ...plan } as FormatPlan)).rejects.toBeInstanceOf(DiagnosticError);
    await executeFormat(plan);
    const afterProject = await loadCanonicalProject(root, "fmt");
    expect(afterProject.assets.map(computeAssetSemanticDigest)).toEqual(beforeDigests);
    expect(await readFile(provenancePath)).toEqual(provenance);
    expect((await diffProvenance(afterProject)).different).toBe(false);
    expect((await diffBuild(afterProject)).different).toBe(true);
    expect(await readFile(join(root, "brand/dist", BUILD_RECEIPT_FILENAME))).toEqual(receiptBefore);
    await bundleProject({ root, output: "bundle-after.zip" });
    expect(await readFile(join(root, "bundle-after.zip"))).toEqual(await readFile(join(root, "bundle-before.zip")));
    expect(await formatProject({ root, check: true })).toMatchObject({ changed: false });
  });

  it("invalidates concurrent format plans without a partial canonical rewrite", async () => {
    const { root } = await initialized();
    const projectPath = join(root, ".tfsb/project.toml");
    const assetPath = join(root, ".tfsb/assets/favicon.toml");
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}# planned\n`);
    await writeFile(assetPath, `${await readFile(assetPath, "utf8")}# planned\n`);
    const plan = await planFormat(root);
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}# concurrent\n`);
    await expect(executeFormat(plan)).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
    expect(await readFile(projectPath, "utf8")).toContain("# concurrent");
    expect(await readFile(assetPath, "utf8")).toContain("# planned");
  });

  it("rolls back a format promotion failure and removes transaction residue", async () => {
    const { root } = await initialized(); const projectPath = join(root, ".tfsb/project.toml");
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}# keep after rollback\n`);
    const plan = await planFormat(root);
    await expect(executeFormat(plan, { beforePromotion: () => { throw new Error("injected"); } })).rejects.toMatchObject({ diagnostic: { code: "TFSB_TRANSACTION_FAILED" } });
    expect(await readFile(projectPath, "utf8")).toContain("# keep after rollback");
    expect((await readdir(root)).filter((name) => name === ".tfsb.lock" || name.startsWith(".tfsb-stage-") || name.startsWith(".tfsb-backup-"))).toEqual([]);
  });

  it("emits deterministic single-envelope JSON with exit parity and empty stderr", async () => {
    const { root, archive } = await initialized(); await buildProject(root); await installProject(root);
    const invoke = async (args: readonly string[]) => { let stdout = ""; let stderr = ""; const exit = await runCli(args, root, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } }); return { exit, stdout, stderr }; };
    const clean = await invoke(["check", "--root", root, "--json"]);
    expect(clean.stderr).toBe(""); expect(clean.exit).toBe(0); expect(clean.stdout.endsWith("\n")).toBe(true); expect(JSON.parse(clean.stdout)).toMatchObject({ schemaVersion: 1, command: "check", status: "ok", exitCode: 0 });
    expect((await invoke(["diff", "--build", "--root", root, "--json"])).stdout).toContain('"command": "diff"');
    for (const args of [
      ["list", "--root", root, "--json"],
      ["diff", "--provenance", "--root", root, "--json"],
      ["diff", "--install", "--root", root, "--json"],
      ["fmt", "--check", "--root", root, "--json"],
      ["bundle", "--output", "machine.zip", "--dry-run", "--root", root, "--json"],
      ["reconcile", archive, "--root", root, "--json"],
    ] as const) {
      const result = await invoke(args);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).exitCode).toBe(result.exit);
    }
    for (const command of ["import", "build", "install"] as const) {
      const unsupported = await invoke(command === "import" ? ["import", archive, "--json"] : [command, "--json"]);
      expect(unsupported.exit).toBe(1);
      expect(unsupported.stdout).toBe("");
      expect(unsupported.stderr).toContain("USAGE_ERROR");
    }
    const externalRoot = join(root, "does-not-exist"); const failed = await invoke(["list", "--root", externalRoot, "--json"]);
    expect(failed.exit).toBe(1); expect(failed.stderr).toBe(""); expect(JSON.parse(failed.stdout)).toMatchObject({ status: "error", exitCode: 1, data: null }); expect(failed.stdout).not.toContain(externalRoot);
    expect((await invoke(["check", "--root", root, "--json"])).stdout).toBe(clean.stdout);

    const mapped = mapMachineDiagnostic({ code: "TOKEN_TEST", operation: "check", domain: "cli", message: "Selected entry 'design-tokens.json' does not exist in manifest." });
    expect(mapped.message).toBe("Selected entry 'design-tokens.json' does not exist in manifest.");
  });

  it("keeps machine output complete above the mutation ceiling and at 2,000 DTO records", async () => {
    const { root } = await initialized();
    const assetsDirectory = join(root, ".tfsb/assets");
    const template = await readFile(join(assetsDirectory, "favicon.toml"), "utf8");
    for (let index = 0; index < 123; index += 1) {
      const id = `scale-${index.toString().padStart(3, "0")}`;
      await writeFile(join(assetsDirectory, `${id}.toml`), template.replace(/^id = .*$/m, `id = "${id}"`).replace(/^filename = .*$/m, `filename = "${id}.svg"`));
    }
    expect((await listProject(root)).assets).toHaveLength(129);
    let stdout = ""; let stderr = "";
    const exit = await runCli(["list", "--root", root, "--json"], root, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
    expect(exit).toBe(0); expect(stderr).toBe(""); expect(JSON.parse(stdout).data.assets).toHaveLength(129);
    stdout = "";
    await runCli(["list", "--root", root], root, { stdout: (text) => { stdout += text; }, stderr: () => undefined });
    expect(stdout).toContain("Summary: 129 total, 50 displayed, 79 omitted; use --json for complete output.");

    const records = Array.from({ length: 2_000 }, (_, index) => ({ id: index, value: `record-${index}` }));
    const serialized = serializeJsonEnvelope(createJsonEnvelope("list", "ok", 0, "Complete.", [], { records }));
    expect((JSON.parse(serialized).data.records as unknown[])).toHaveLength(2_000);
    expect(serialized.endsWith("\n")).toBe(true);
  });
});
