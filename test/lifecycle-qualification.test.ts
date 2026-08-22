import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildProject } from "../src/build.js";
import { bundleProject } from "../src/bundle.js";
import { checkProject } from "../src/check.js";
import { runCli } from "../src/cli.js";
import { diffArchive, diffBuild, diffInstall, diffProvenance } from "../src/diff.js";
import { formatProject } from "../src/fmt.js";
import { importProject } from "../src/importer.js";
import { installProject } from "../src/install.js";
import { listProject } from "../src/list.js";
import { previewProject } from "../src/preview.js";
import { loadCanonicalProject } from "../src/project.js";
import { reconcileProject } from "../src/reconcile.js";

const FIXTURE = join(process.cwd(), "test/fixtures/tftn-production-v1");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function productionProject(): Promise<{ root: string; archive: string; companion: Uint8Array }> {
  const root = await mkdtemp(join(tmpdir(), "tfsb24-lifecycle-"));
  roots.push(root);
  const entries: Record<string, Uint8Array> = {};
  for (const name of await readdir(FIXTURE)) entries[name] = await readFile(join(FIXTURE, name));
  const archive = join(root, "production.zip");
  await writeFile(archive, zipSync(entries, { level: 6, mtime: new Date("1980-01-02T00:00:00Z") }));
  const imported = await importProject({ archive, root, companions: ["README.md", "brand-README.md"], recordProvenance: true });
  const installs = imported.assets.map((asset) => `[[install]]\nasset = "${asset.id}"\ndestinations = ["installed/${asset.filename}"]\n`).join("\n");
  const projectPath = join(root, ".tfsb/project.toml");
  await writeFile(projectPath, `${await readFile(projectPath, "utf8")}\n${installs}\n[[companion]]\nfile = "README.md"\ndestinations = ["installed/README.md"]\n\n[[companion]]\nfile = "brand-README.md"\ndestinations = ["installed/brand-README.md"]\n`);
  await formatProject({ root });
  return { root, archive, companion: entries["brand-README.md"]! };
}

async function jsonCli(root: string, args: readonly string[]): Promise<unknown> {
  let stdout = "";
  let stderr = "";
  const exit = await runCli([...args, "--root", root, "--json"], root, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.indexOf("\n") > 0).toBe(true);
  return JSON.parse(stdout);
}

describe("TFSB24 integrated Terminal Nova lifecycle", () => {
  it("qualifies the complete clean human/machine lifecycle and canonical preview authority", async () => {
    const { root, archive, companion } = await productionProject();
    const reconciliation = await reconcileProject({ archive, root, companions: ["README.md", "brand-README.md"] });
    expect(reconciliation).toMatchObject({ blocked: false, pending: false });
    await buildProject(root);
    await installProject(root);
    expect(await checkProject(root)).toMatchObject({ drift: false });
    expect((await listProject(root)).assets).toHaveLength(10);
    let project = await loadCanonicalProject(root, "diff");
    expect((await diffProvenance(project)).different).toBe(false);
    expect((await diffArchive(project, archive)).different).toBe(false);
    expect((await diffBuild(project)).different).toBe(false);
    expect((await diffInstall(project)).different).toBe(false);
    expect(await formatProject({ root, check: true })).toMatchObject({ changed: false, applied: false });
    await bundleProject({ root, output: "human-bundle.zip" });
    const preview = await previewProject({ root });
    expect(preview.assets).toHaveLength(10);
    expect(await readFile(join(root, ".tfsb-preview/assets", preview.assets[0]!.filename))).toEqual((await loadCanonicalProject(root, "preview")).outputs.get(preview.assets[0]!.filename));
    expect(await readFile(join(root, ".tfsb/companions/brand-README.md"))).toEqual(companion);
    expect(await readFile(join(root, "installed/brand-README.md"))).toEqual(companion);
    expect(await readFile(join(root, ".tfsb-preview/index.html"), "utf8")).not.toContain(Buffer.from(companion).toString("utf8"));

    expect(await jsonCli(root, ["check"])).toMatchObject({ command: "check", status: "ok", exitCode: 0 });
    expect(await jsonCli(root, ["list"])).toMatchObject({ command: "list", status: "ok", exitCode: 0 });
    expect(await jsonCli(root, ["diff", "--provenance"])).toMatchObject({ command: "diff", status: "ok", exitCode: 0 });
    expect(await jsonCli(root, ["diff", "--archive", archive])).toMatchObject({ command: "diff", status: "ok", exitCode: 0 });
    expect(await jsonCli(root, ["diff", "--build"])).toMatchObject({ command: "diff", status: "ok", exitCode: 0 });
    expect(await jsonCli(root, ["diff", "--install"])).toMatchObject({ command: "diff", status: "ok", exitCode: 0 });
    expect(await jsonCli(root, ["fmt", "--check"])).toMatchObject({ command: "fmt", status: "ok", exitCode: 0 });
    expect(await jsonCli(root, ["bundle", "--output", "machine-bundle.zip"])).toMatchObject({ command: "bundle", status: "ok", exitCode: 0 });
    expect(await jsonCli(root, ["preview"])).toMatchObject({ command: "preview", status: "ok", exitCode: 0 });

    project = await loadCanonicalProject(root, "preview");
    const asset = project.assets[0]!;
    const canonicalAssetPath = join(root, ".tfsb/assets", `${asset.id}.toml`);
    await writeFile(canonicalAssetPath, (await readFile(canonicalAssetPath, "utf8")).replace(/^title = ".*"$/m, 'title = "Semantically changed title"'));
    const semanticPreview = await previewProject({ root });
    expect(semanticPreview.assets.find((item) => item.id === asset.id)?.buildStatus).toBe("byte_different");
    expect(await readFile(join(root, ".tfsb-preview/assets", asset.filename))).toEqual((await loadCanonicalProject(root, "preview")).outputs.get(asset.filename));
    expect((await diffProvenance(await loadCanonicalProject(root, "diff"))).different).toBe(true);
    expect((await checkProject(root)).sourceChanged).toBe(true);

    const beforeFormatPreview = await readFile(join(root, ".tfsb-preview/assets", asset.filename));
    await writeFile(canonicalAssetPath, `${await readFile(canonicalAssetPath, "utf8")}# formatting only\n`);
    await bundleProject({ root, output: "before-format.zip" });
    await formatProject({ root });
    await previewProject({ root });
    await bundleProject({ root, output: "after-format.zip" });
    expect(await readFile(join(root, ".tfsb-preview/assets", asset.filename))).toEqual(beforeFormatPreview);
    const beforeZip = unzipSync(await readFile(join(root, "before-format.zip")));
    const afterZip = unzipSync(await readFile(join(root, "after-format.zip")));
    expect(beforeZip[asset.filename]).toEqual(afterZip[asset.filename]);

    await writeFile(join(root, "brand/dist", asset.filename), "build drift");
    await writeFile(join(root, "installed", asset.filename), "install drift");
    await writeFile(join(root, "installed/brand-README.md"), "companion drift");
    const driftPreview = await previewProject({ root });
    expect(driftPreview.assets.find((item) => item.id === asset.id)).toMatchObject({ buildStatus: "byte_different", installStatus: "byte_different" });
    expect(driftPreview.companions.find((item) => item.file === "brand-README.md")).toMatchObject({ file: "brand-README.md", installStatus: "byte_different" });
    await buildProject(root);
    await installProject(root);
    expect(await checkProject(root)).toMatchObject({ drift: false });
    expect((await diffBuild(await loadCanonicalProject(root, "diff"))).different).toBe(false);
    expect((await diffInstall(await loadCanonicalProject(root, "diff"))).different).toBe(false);
    expect(await readFile(join(root, ".tfsb/companions/brand-README.md"))).toEqual(companion);
  });
});
