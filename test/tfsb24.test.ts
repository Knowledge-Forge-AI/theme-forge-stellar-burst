import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildProject, executeBuild, planBuild, type BuildPlan } from "../src/build.js";
import { checkProject } from "../src/check.js";
import { runCli } from "../src/cli.js";
import { diffArchive } from "../src/diff.js";
import { computeRawSha256 } from "../src/digests.js";
import { DiagnosticError } from "../src/diagnostics.js";
import { executeFormat, formatProject, planFormat } from "../src/fmt.js";
import { importProject } from "../src/importer.js";
import { executeInstall, planInstall, type InstallPlan } from "../src/install.js";
import { listProject } from "../src/list.js";
import { createJsonEnvelope, mapListJson, mapMachineDiagnostic, mapReconcileJson, serializeJsonEnvelope } from "../src/json.js";
import { loadCanonicalProject } from "../src/project.js";
import { planReconciliation } from "../src/reconcile.js";
import {
  executePreviewPlan,
  parsePreviewMarker,
  planPreview,
  previewProject,
  type PreviewPlan,
} from "../src/preview.js";
import { BUILD_RECEIPT_FILENAME, readBuildReceipt, serializeBuildReceipt, type BuildReceiptV3 } from "../src/receipt.js";

const FIXTURE = join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function initialized(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb24-"));
  roots.push(root);
  const files: Record<string, Uint8Array> = {};
  for (const name of await readdir(FIXTURE)) files[name] = await readFile(join(FIXTURE, name));
  const archive = join(root, "fixture.zip");
  await writeFile(archive, zipSync(files, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }));
  await importProject({ archive, root, schema: 1, recordProvenance: true });
  return root;
}

async function previewBytes(root: string): Promise<Record<string, Uint8Array>> {
  const result: Record<string, Uint8Array> = {};
  for (const name of ["index.html", "preview.css", ".tfsb-preview.json"]) result[name] = await readFile(join(root, ".tfsb-preview", name));
  for (const name of await readdir(join(root, ".tfsb-preview/assets"))) result[`assets/${name}`] = await readFile(join(root, ".tfsb-preview/assets", name));
  return result;
}

describe("TFSB24 static preview", () => {
  it("writes an offline escaped deterministic marker-owned gallery from canonical SVG bytes", async () => {
    const root = await initialized();
    const assetPath = join(root, ".tfsb/assets/favicon.toml");
    const assetToml = await readFile(assetPath, "utf8");
    await writeFile(assetPath, assetToml.replace(
      'title = "Terminal Nova favicon"',
      `title = "</h2><script>alert(1)</script>&'\\"quoted\\""`,
    ));
    const first = await previewProject({ root });
    expect(first).toMatchObject({ outputDirectory: ".tfsb-preview", written: true, replaced: false, assetCount: 6, opened: { requested: false, status: "not_requested" } });
    const top = (await readdir(join(root, ".tfsb-preview"))).sort();
    expect(top).toEqual([".tfsb-preview.json", "assets", "index.html", "preview.css"]);
    const html = await readFile(join(root, ".tfsb-preview/index.html"), "utf8");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("onerror=");
    expect(html).toContain("&lt;/h2&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;");
    expect(html).toContain("&#39;&quot;quoted&quot;");
    expect(html.match(/class="surface surface-/g)).toHaveLength(30);
    expect(html).toContain('loading="lazy" decoding="async"');
    expect(html).toContain("16 px");
    expect(html).toContain("24 px");
    expect(html).toContain("32 px");
    expect(html).toContain("48 px");
    expect(html).toContain("default-src 'none'");
    const markerState = parsePreviewMarker(await readFile(join(root, ".tfsb-preview/.tfsb-preview.json"), "utf8"));
    expect(markerState.status).toBe("valid");
    const canonical = await loadCanonicalProject(root, "preview");
    for (const asset of canonical.assets) expect(await readFile(join(root, ".tfsb-preview/assets", asset.filename))).toEqual(canonical.outputs.get(asset.filename));
    const bytes = await previewBytes(root);
    const second = await previewProject({ root });
    expect(second.replaced).toBe(true);
    expect(await previewBytes(root)).toEqual(bytes);
  });

  it("fails closed on unowned, mismatched, and symlink preview targets", async () => {
    const root = await initialized();
    await mkdir(join(root, ".tfsb-preview"));
    await writeFile(join(root, ".tfsb-preview/ordinary.txt"), "mine");
    await expect(planPreview({ root })).rejects.toMatchObject({ diagnostic: { code: "PREVIEW_UNOWNED_DIRECTORY" } });
    await rm(join(root, ".tfsb-preview"), { recursive: true });
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(root, ".tfsb-preview"));
    await expect(planPreview({ root })).rejects.toMatchObject({ diagnostic: { code: "ROOT_SYMLINK_ESCAPE" } });
  });

  it("protects preview output from build, canonical, source, and destination overlap", async () => {
    const buildOverlap = await initialized();
    const buildProjectPath = join(buildOverlap, ".tfsb/project.toml");
    await writeFile(buildProjectPath, (await readFile(buildProjectPath, "utf8")).replace('directory = "brand/dist"', 'directory = ".tfsb-preview"'));
    await expect(planPreview({ root: buildOverlap })).rejects.toMatchObject({ diagnostic: { code: "ROOT_UNSAFE_BUILD_DIRECTORY" } });

    const destinationOverlap = await initialized();
    const destinationProjectPath = join(destinationOverlap, ".tfsb/project.toml");
    await writeFile(destinationProjectPath, `${await readFile(destinationProjectPath, "utf8")}\n[[install]]\nasset = "favicon"\ndestinations = ["gallery/favicon.svg"]\n`);
    await expect(planPreview({ root: destinationOverlap, output: "gallery" })).rejects.toMatchObject({ diagnostic: { code: "PREVIEW_UNSAFE_OUTPUT" } });
    await expect(planPreview({ root: destinationOverlap, output: "src/preview" })).rejects.toMatchObject({ diagnostic: { code: "PREVIEW_UNSAFE_OUTPUT" } });
    await expect(planPreview({ root: destinationOverlap, output: ".tfsb/preview" })).rejects.toMatchObject({ diagnostic: { code: "PREVIEW_UNSAFE_OUTPUT" } });
  });

  it("rejects forged plans and canonical changes before publication", async () => {
    const root = await initialized();
    const plan = await planPreview({ root });
    await expect(executePreviewPlan({ ...plan } as PreviewPlan)).rejects.toMatchObject({ diagnostic: { code: "PREVIEW_INVALID_PLAN" } });
    const projectPath = join(root, ".tfsb/project.toml");
    await expect(executePreviewPlan(plan, { afterStage: async () => writeFile(projectPath, `${await readFile(projectPath, "utf8")}# concurrent\n`) })).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
    await expect(readFile(join(root, ".tfsb-preview/index.html"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores an owned preview after handled promotion failure and refuses a concurrently appeared target", async () => {
    const root = await initialized();
    await previewProject({ root });
    const before = await previewBytes(root);
    const replacement = await planPreview({ root });
    await expect(executePreviewPlan(replacement, { afterBackup: () => { throw new Error("promotion failed"); } })).rejects.toThrow("promotion failed");
    expect(await previewBytes(root)).toEqual(before);
    expect((await readdir(root)).filter((name) => name.includes("tfsb-stage") || name.includes("tfsb-backup"))).toEqual([]);

    await rm(join(root, ".tfsb-preview"), { recursive: true });
    const absent = await planPreview({ root });
    await expect(executePreviewPlan(absent, { afterStage: async () => { await mkdir(join(root, ".tfsb-preview")); await writeFile(join(root, ".tfsb-preview/ordinary.txt"), "external"); } })).rejects.toMatchObject({ diagnostic: { code: "PREVIEW_UNOWNED_DIRECTORY" } });
    expect(await readFile(join(root, ".tfsb-preview/ordinary.txt"), "utf8")).toBe("external");
  });

  it("reports derived drift without changing canonical image authority", async () => {
    const root = await initialized();
    await buildProject(root);
    const canonical = await loadCanonicalProject(root, "preview");
    const changed = canonical.assets[0]!;
    await writeFile(join(root, "brand/dist", changed.filename), "drift");
    const result = await previewProject({ root });
    expect(result.assets.find((asset) => asset.id === changed.id)?.buildStatus).toBe("byte_different");
    expect(await readFile(join(root, ".tfsb-preview/assets", changed.filename))).toEqual(canonical.outputs.get(changed.filename));
  });

  it("uses an injectable best-effort opener after commit", async () => {
    const root = await initialized();
    const opened: string[] = [];
    expect((await previewProject({ root, open: true, opener: { interactive: false, open: async () => undefined } })).opened.status).toBe("skipped");
    expect((await previewProject({ root, open: true, opener: { interactive: true, open: async (path) => { opened.push(path); } } })).opened.status).toBe("opened");
    expect(opened[0]).toMatch(/\.tfsb-preview\/index\.html$/);
    expect((await previewProject({ root, open: true, opener: { interactive: true, open: async () => { throw new Error("no opener"); } } })).opened.status).toBe("failed");
  });

  it("emits exactly one preview JSON envelope with project-relative data", async () => {
    const root = await initialized();
    let stdout = "";
    let stderr = "";
    const exit = await runCli(["preview", "--root", root, "--json"], root, { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } });
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.endsWith("\n")).toBe(true);
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({ schemaVersion: 1, command: "preview", status: "ok", exitCode: 0, data: { outputDirectory: ".tfsb-preview", written: true } });
    expect(stdout).not.toContain(root);
  });

  it("keeps promoted preview active if backup cleanup fails", async () => {
    const root = await initialized();
    await previewProject({ root });
    await expect(
      previewProject({ root }, {
        beforeBackupCleanup: async () => {
          throw new Error("simulated backup cleanup failure");
        },
      })
    ).rejects.toMatchObject({ diagnostic: { code: "PREVIEW_BACKUP_CLEANUP_FAILED" } });
    const marker = parsePreviewMarker(await readFile(join(root, ".tfsb-preview/.tfsb-preview.json"), "utf8"));
    expect(marker.status).toBe("valid");
  });

  it("restores prior preview when target changes after planning", async () => {
    const root = await initialized();
    await previewProject({ root });
    const originalMarker = await readFile(join(root, ".tfsb-preview/.tfsb-preview.json"), "utf8");
    await expect(
      previewProject({ root }, {
        afterStage: async () => {
          await writeFile(join(root, ".tfsb-preview/assets/favicon.svg"), "tampered");
        },
      })
    ).rejects.toMatchObject({ diagnostic: { code: "PREVIEW_UNOWNED_DIRECTORY" } });
    expect(await readFile(join(root, ".tfsb-preview/.tfsb-preview.json"), "utf8")).toBe(originalMarker);
  });
});

describe("TFSB24 carry-forward lifecycle hardening", () => {
  it("serializes shuffled valid v2/v3 receipts to identical bytes", async () => {
    const root = await initialized();
    await buildProject(root);
    const state = await readBuildReceipt(join(root, "brand/dist"));
    if (state.status !== "v3") throw new Error("Expected v3 receipt.");
    const reversed = (value: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(value).reverse());
    const shuffled = {
      outputs: reversed(state.receipt.outputs),
      projectPolicy: { companions: [...state.receipt.projectPolicy.companions].reverse(), installs: [...state.receipt.projectPolicy.installs].reverse(), buildDirectory: state.receipt.projectPolicy.buildDirectory },
      canonicalSources: reversed(state.receipt.canonicalSources),
      buildDirectory: state.receipt.buildDirectory,
      toolVersion: state.receipt.toolVersion,
      schemaVersion: 3,
      kind: "tfsb-build-v3",
    } as BuildReceiptV3;
    expect(serializeBuildReceipt(shuffled)).toEqual(serializeBuildReceipt(state.receipt));
  });

  it("never follows receipt symlinks while preview degrades derived state to unavailable", async () => {
    const root = await initialized();
    await buildProject(root);
    const receipt = join(root, "brand/dist", BUILD_RECEIPT_FILENAME);
    const external = join(root, "external-receipt.json");
    await writeFile(external, await readFile(receipt));
    await rm(receipt);
    await symlink(external, receipt);
    await expect(checkProject(root)).rejects.toMatchObject({ diagnostic: { code: "BUILD_UNSAFE_CONTENT" } });
    await expect(planBuild(root)).rejects.toMatchObject({ diagnostic: { code: "BUILD_UNSAFE_CONTENT" } });
    await expect(planInstall(root)).rejects.toMatchObject({ diagnostic: { code: "BUILD_UNSAFE_CONTENT" } });
    expect((await previewProject({ root })).assets.every((asset) => asset.buildStatus === "unavailable")).toBe(true);
  });

  it("never follows install destination symlinks while preview reports them unavailable", async () => {
    const root = await initialized();
    const projectPath = join(root, ".tfsb/project.toml");
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}\n[[install]]\nasset = "favicon"\ndestinations = ["consumer/favicon.svg"]\n`);
    await buildProject(root);
    const external = join(root, "external.svg");
    await writeFile(external, "external");
    await mkdir(join(root, "consumer"));
    await symlink(external, join(root, "consumer/favicon.svg"));
    await expect(checkProject(root)).rejects.toMatchObject({ diagnostic: { code: "INSTALL_UNSAFE_DESTINATION" } });
    await expect(planInstall(root)).rejects.toMatchObject({ diagnostic: { code: "INSTALL_UNSAFE_DESTINATION" } });
    const preview = await previewProject({ root });
    expect(preview.assets.find((asset) => asset.id === "favicon")).toMatchObject({ installStatus: "unavailable", destinations: [{ path: "consumer/favicon.svg", status: "unavailable" }] });
    expect(await readFile(external, "utf8")).toBe("external");
  });

  it("never follows generated output symlinks while preview reports build unavailable", async () => {
    const root = await initialized();
    await buildProject(root);
    const project = await loadCanonicalProject(root, "check");
    const filename = project.assets[0]!.filename;
    const output = join(root, "brand/dist", filename);
    const external = join(root, "external-output.svg");
    await writeFile(external, "external");
    await rm(output);
    await symlink(external, output);
    await expect(checkProject(root)).rejects.toMatchObject({ diagnostic: { code: "BUILD_UNSAFE_CONTENT" } });
    await expect(planInstall(root)).rejects.toMatchObject({ diagnostic: { code: "BUILD_UNSAFE_CONTENT" } });
    expect((await previewProject({ root })).assets.every((asset) => asset.buildStatus === "unavailable")).toBe(true);
    expect(await readFile(external, "utf8")).toBe("external");
  });

  it("preserves manifest asset identity while reporting an exact filename change", async () => {
    const root = await initialized();
    const project = await loadCanonicalProject(root, "diff");
    const asset = project.assets.find((item) => item.id === "favicon")!;
    const bytes = project.outputs.get(asset.filename)!;
    const filename = "renamed-favicon.svg";
    const manifest = {
      kind: "tfsb-bundle-manifest",
      schemaVersion: 1,
      generator: { name: "@knowledge-forge-ai/theme-forge-stellar-burst", version: "0.1.0" },
      projectName: project.project.name,
      files: [{ type: "asset", name: filename, assetId: asset.id, sha256: computeRawSha256(bytes) }],
    };
    const archive = join(root, "manifest-filename.zip");
    await writeFile(archive, zipSync({ "tfsb-manifest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), [filename]: bytes }, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }));
    const result = await diffArchive(project, archive);
    expect(result.changes).toContainEqual(expect.objectContaining({ key: "asset:favicon", category: "asset_identity", location: "filename", changeType: "changed", before: "favicon.svg", after: filename }));
  });

  it("represents a colliding new asset as rename authority rather than resolution authority", async () => {
    const root = await initialized();
    const archive = join(root, "collision.zip");
    await writeFile(archive, zipSync({ "nested/favicon.svg": await readFile(join(FIXTURE, "favicon.svg")) }, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }));
    const result = await planReconciliation({ archive, root });
    const collision = result.records.find((record) => record.plannedAction === "blocked_collision");
    expect(collision).toMatchObject({ classification: "NEW_ASSET", blocker: true, plannedAction: "blocked_collision", requiredAuthority: "rename" });
    expect(mapReconcileJson({ ...result, applied: false }).records.find((record) => record.plannedAction === "blocked_collision")).toMatchObject({ requiredAuthority: "rename", resolutionRequired: false });
  });

  it("maps structural diagnostic locations while refusing path, token, stack, and environment leaks", () => {
    expect(mapMachineDiagnostic({ code: "SVG_FIELD", operation: "parse", domain: "svg", location: "/svg/title", message: "Invalid title." })).toMatchObject({ severity: "error", modelLocation: "/svg/title", message: "Invalid title." });
    expect(mapMachineDiagnostic({ code: "MANIFEST_FIELD", operation: "parse", domain: "manifest", location: "files[0].name", message: "Invalid manifest name." })).toMatchObject({ modelLocation: "files[0].name" });
    expect(mapMachineDiagnostic({ code: "ARCHIVE_ENTRY", operation: "diff", domain: "archive", location: "icons/mark.svg", message: "Invalid archive entry." })).toMatchObject({ archiveEntry: "icons/mark.svg" });
    expect(mapMachineDiagnostic({ code: "PATH", operation: "check", domain: "filesystem", location: ".tfsb/project.toml", message: "Safe project path." })).toMatchObject({ path: ".tfsb/project.toml" });
    for (const message of [
      "failed at /Users/private-user/project/file",
      "failed at /opt/private-project/file",
      "failed at C:\\Users\\private-user\\file",
      "api_token=secret-value",
      "username=private-user",
      "hostname=private-host",
      "Error: boom\n    at privateFunction (/tmp/private.js:1:1)",
      "process.env contained private state",
    ]) {
      const mapped = mapMachineDiagnostic({ code: "LEAK", operation: "check", domain: "cli", location: "/Users/private-user/file", message });
      expect(mapped.message).toBe("The operation could not be completed safely.");
      expect(mapped).not.toHaveProperty("path");
    }
    expect(mapMachineDiagnostic({ code: "LEAK", operation: "parse", domain: "manifest", location: "/opt/private-manifest.json", message: "Invalid manifest." })).not.toHaveProperty("modelLocation");
    expect(mapMachineDiagnostic({ code: "SAFE", operation: "check", domain: "cli", message: "design-tokens entry is invalid." }).message).toBe("design-tokens entry is invalid.");
  });

  it("orders representative machine arrays by accepted UTF-8 bytes deterministically", () => {
    const bmp = "\uE000";
    const astral = "\u{10000}";
    const list = mapListJson({
      assets: [
        { id: astral, filename: "astral.svg", buildPath: "build/astral.svg", destinations: [`dest/${astral}`, `dest/${bmp}`] },
        { id: bmp, filename: "bmp.svg", buildPath: "build/bmp.svg", destinations: [] },
      ],
      companions: [],
    });
    expect(list.assets.map((asset) => asset.id)).toEqual([bmp, astral]);
    expect(list.assets[1]!.destinations).toEqual([`dest/${bmp}`, `dest/${astral}`]);
    const diagnostics = [
      { code: astral, severity: "error" as const, operation: "check", domain: "cli", message: "astral" },
      { code: bmp, severity: "error" as const, operation: "check", domain: "cli", message: "bmp" },
    ];
    const first = serializeJsonEnvelope(createJsonEnvelope("list", "ok", 0, "ordered", diagnostics, list));
    const second = serializeJsonEnvelope(createJsonEnvelope("list", "ok", 0, "ordered", [...diagnostics].reverse(), list));
    expect(second).toBe(first);
    expect(JSON.parse(first).diagnostics.map((item: { code: string }) => item.code)).toEqual([bmp, astral]);
  });

  it("rejects forged build/install plans and stale destination authority", async () => {
    const root = await initialized();
    const build = await planBuild(root);
    expect(Reflect.set(build.receipt.outputs, "forged.svg", "0".repeat(64))).toBe(false);
    await expect(executeBuild({ ...build } as BuildPlan)).rejects.toMatchObject({ diagnostic: { code: "BUILD_INVALID_PLAN" } });
    await executeBuild(build);
    expect(await readdir(join(root, "brand/dist"))).not.toContain("forged.svg");

    const projectPath = join(root, ".tfsb/project.toml");
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}\n[[install]]\nasset = "favicon"\ndestinations = ["consumer/a.svg", "consumer/b.svg"]\n`);
    await buildProject(root);
    const install = await planInstall(root);
    await expect(executeInstall({ ...install } as InstallPlan)).rejects.toMatchObject({ diagnostic: { code: "INSTALL_INVALID_PLAN" } });
    await mkdir(join(root, "consumer"));
    await writeFile(join(root, "consumer/b.svg"), "concurrent");
    await expect(executeInstall(install)).rejects.toMatchObject({ diagnostic: { code: "INSTALL_DESTINATION_CHANGED_DURING_PLAN" } });
    await expect(readFile(join(root, "consumer/a.svg"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "consumer/b.svg"), "utf8")).toBe("concurrent");
  });

  it("prevents stale build and install plans from applying after canonical edits", async () => {
    const root = await initialized();
    const staleBuild = await planBuild(root);
    const projectPath = join(root, ".tfsb/project.toml");
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}# concurrent build edit\n`);
    await expect(executeBuild(staleBuild)).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
    await expect(readFile(join(root, "brand/dist", BUILD_RECEIPT_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });

    await formatProject({ root });
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}\n[[install]]\nasset = "favicon"\ndestinations = ["consumer/a.svg"]\n`);
    await buildProject(root);
    const staleInstall = await planInstall(root);
    const assetPath = join(root, ".tfsb/assets/favicon.toml");
    await writeFile(assetPath, `${await readFile(assetPath, "utf8")}# concurrent install edit\n`);
    await expect(executeInstall(staleInstall)).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
    await expect(readFile(join(root, "consumer/a.svg"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces the aggregate 128/129 mutation boundary while preserving read-only inspection", async () => {
    const root = await initialized();
    const assetsDirectory = join(root, ".tfsb/assets");
    const template = await readFile(join(assetsDirectory, "favicon.toml"), "utf8");
    await rm(assetsDirectory, { recursive: true });
    await mkdir(assetsDirectory);
    for (let index = 0; index < 129; index += 1) {
      const id = `asset-${String(index).padStart(3, "0")}`;
      const text = template.replace('id = "favicon"', `id = "${id}"`).replace('filename = "favicon.svg"', `filename = "${id}.svg"`);
      await writeFile(join(assetsDirectory, `${id}.toml`), text);
    }
    expect((await listProject(root)).assets).toHaveLength(129);
    expect((await checkProject(root)).valid).toBe(true);
    expect((await formatProject({ root, check: true })).check).toBe(true);
    await expect(planBuild(root)).rejects.toMatchObject({ diagnostic: { code: "RESOURCE_LIMIT_EXCEEDED" } });
    await expect(planInstall(root)).rejects.toMatchObject({ diagnostic: { code: "RESOURCE_LIMIT_EXCEEDED" } });
    await expect(planPreview({ root })).rejects.toMatchObject({ diagnostic: { code: "RESOURCE_LIMIT_EXCEEDED" } });
    const projectPath = join(root, ".tfsb/project.toml");
    await writeFile(projectPath, `${await readFile(projectPath, "utf8")}# format me\n`);
    await expect(executeFormat(await planFormat(root))).rejects.toMatchObject({ diagnostic: { code: "RESOURCE_LIMIT_EXCEEDED" } });
    expect(await readdir(root)).not.toContain(".tfsb.lock");
    await rm(join(assetsDirectory, "asset-128.toml"));
    expect((await planBuild(root)).outputs).toHaveLength(128);
    expect((await planPreview({ root })).assetCount).toBe(128);
  });
});
