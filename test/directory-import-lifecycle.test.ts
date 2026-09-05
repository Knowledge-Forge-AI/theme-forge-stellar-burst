import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildProject,
  bundleProject,
  checkProject,
  diffProject,
  formatProject,
  getDirectorySnapshotCapability,
  importProject,
  installProject,
  listProject,
  migrateProject,
  parseAssetTomlV2,
  parseImportProvenanceV3,
  previewProject,
  reconcileProject,
  serializeSvgV2,
} from "../src/index.js";
import { makeTempDir, readRepoFile, unwrap } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function temp(): string { const value = realpathSync(makeTempDir("tfsb-directory-lifecycle-")); roots.push(value); return value; }
function canonicalSvg(): string { const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml"))); return unwrap(serializeSvgV2(asset.svg)); }
function map(): string { return 'schema_version = 1\nsource_root = "."\n\n[[collection]]\nid = "terminal-nova-brand"\nname = "Synthetic Terminal Nova topology"\nroot = "."\nidentity = "basename"\nprefix = ""\ninclude_paths = []\ninclude_trees = ["svg"]\nexclude_paths = []\nexclude_trees = []\n'; }

const nativeAvailable = getDirectorySnapshotCapability(realpathSync(tmpdir())).supported;

describe.runIf(nativeAvailable)("directory import lifecycle qualification", () => {
  it("qualifies a repository-owned 10-asset Terminal Nova-style topology without exporting source authority", async () => {
    const base = temp(); const source = join(base, "source"); const root = join(base, "project");
    await mkdir(join(source, "svg"), { recursive: true }); await mkdir(root); await mkdir(join(root, "installed"));
    const svg = canonicalSvg();
    await Promise.all(Array.from({ length: 10 }, (_, index) => writeFile(join(source, "svg", `nova-${index}.svg`), svg)));
    await writeFile(join(source, "README.md"), "Synthetic fixture terms only.\n");
    await writeFile(join(source, ".tfsb-source-map.toml"), map());
    await importProject({ source: { kind: "directory", path: source }, root, collections: ["terminal-nova-brand"], companions: ["README.md"] });
    const provenanceText = await readFile(join(root, ".tfsb", "provenance.json"), "utf8");
    const provenance = unwrap(parseImportProvenanceV3(provenanceText));
    expect(provenance.records).toHaveLength(11);
    expect(new Set(provenance.records.map((record) => record.source?.kind === "directory" ? record.source.snapshotDigest : null)).size).toBe(1);
    expect(provenanceText).not.toContain(source);

    await writeFile(join(root, ".tfsb", "project.toml"), `schema_version = 2\nname = "terminal-nova-synthetic"\n\n[build]\ndirectory = "brand/dist"\n\n[[install]]\nasset = "nova-0"\ndestinations = [\n  "installed/nova-0.svg",\n]\n`);
    await buildProject(root);
    await installProject(root);
    expect(await checkProject(root)).toMatchObject({ valid: true, build: { missing: [], extra: [], different: [] }, install: { missing: [], different: [] } });
    expect((await listProject(root)).assets).toHaveLength(10);
    expect(await diffProject({ root, baseline: "provenance" })).toMatchObject({ baseline: "provenance", different: false });
    await formatProject({ root, check: true });
    expect(await migrateProject({ root, check: true })).toMatchObject({ migrationNeeded: false, fromSchemaVersion: 2, toSchemaVersion: 2 });
    expect(await readFile(join(root, ".tfsb", "provenance.json"), "utf8")).toBe(provenanceText);

    await writeFile(join(source, "svg", "nova-renamed.svg"), svg);
    await rm(join(source, "svg", "nova-0.svg"));
    await writeFile(join(source, "svg", "nova-1.svg"), svg.replace('r="8"', 'r="7"'));
    await writeFile(join(source, "svg", "nova-2.svg"), `${svg}\n`);
    await rm(join(source, "svg", "nova-9.svg"));
    await writeFile(join(source, "README.md"), "Synthetic fixture terms updated.\n");
    const reconciled = await reconcileProject({
      directory: source,
      root,
      sourceMap: join(source, ".tfsb-source-map.toml"),
      collections: ["terminal-nova-brand"],
      renames: ["nova-0=svg/nova-renamed.svg"],
      apply: true,
    });
    expect(reconciled.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "asset:nova-0", plannedAction: "rename", blocker: false }),
      expect.objectContaining({ key: "asset:nova-1", classification: "SOURCE_CHANGED" }),
      expect.objectContaining({ key: "asset:nova-2", classification: "SOURCE_FORMATTING_ONLY" }),
      expect.objectContaining({ key: "asset:nova-9", classification: "SOURCE_OMISSION" }),
      expect.objectContaining({ key: "companion:README.md", classification: "SOURCE_CHANGED" }),
    ]));
    expect(await readFile(join(root, ".tfsb", "companions", "README.md"), "utf8")).toBe("Synthetic fixture terms updated.\n");
    await access(join(root, ".tfsb", "assets", "nova-9.toml"));
    expect(await readFile(join(root, ".tfsb", "project.toml"), "utf8")).toContain('asset = "nova-renamed"');
    expect(await readFile(join(root, ".tfsb", "project.toml"), "utf8")).toContain('"installed/nova-0.svg"');
    await buildProject(root);
    await installProject(root);
    expect(await checkProject(root)).toMatchObject({ valid: true, build: { missing: [], extra: [], different: [] }, install: { missing: [], different: [] } });
    expect((await listProject(root)).assets).toHaveLength(10);
    expect(await diffProject({ root, baseline: "provenance" })).toMatchObject({ baseline: "provenance", different: false });
    const archiveComparison = join(base, "comparison.zip");
    const currentIds = ["nova-renamed", ...Array.from({ length: 9 }, (_, index) => `nova-${index + 1}`)];
    await writeFile(archiveComparison, zipSync({
      ...Object.fromEntries(await Promise.all(currentIds.map(async (id) => [`${id}.svg`, await readFile(join(root, "brand", "dist", `${id}.svg`))] as const))),
      "README.md": Buffer.from("Synthetic fixture terms updated.\n"),
    }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    expect(await diffProject({ root, baseline: "archive", archive: archiveComparison })).toMatchObject({ baseline: "archive", different: false });
    await expect(reconcileProject({ root, archive: archiveComparison })).rejects.toMatchObject({ diagnostic: { code: "RECONCILE_SOURCE_KIND_UNSUPPORTED" } });

    const bundle = await bundleProject({ root, output: "portable.zip" });
    expect(bundle.assetCount).toBe(10); expect(bundle.companionCount).toBe(1);
    const zip = unzipSync(await readFile(join(root, "portable.zip")));
    expect(Object.keys(zip)).not.toContain(".tfsb-source-map.toml");
    expect(Buffer.concat(Object.values(zip).map((bytes) => Buffer.from(bytes))).toString("utf8")).not.toContain("svg/nova-");
    const imported = join(base, "manifest-import"); await mkdir(imported);
    await importProject({ archive: join(root, "portable.zip"), root: imported, schema: 2, manifest: true });
    await access(join(imported, ".tfsb", "assets", "nova-renamed.toml"));

    const preview = await previewProject({ root });
    expect(preview.assets).toHaveLength(10);
  });

  it("keeps canonical project, asset, and companion bytes equal across equivalent archive and directory normalization", async () => {
    const base = temp();
    const directorySource = join(base, "directory-source"); const archiveRoot = join(base, "archive", "project"); const directoryRoot = join(base, "directory", "project");
    await mkdir(join(directorySource, "icons"), { recursive: true }); await mkdir(archiveRoot, { recursive: true }); await mkdir(directoryRoot, { recursive: true });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Parity title</title><path d="M0 0L1 1"/></svg>';
    await writeFile(join(directorySource, "icons", "parity.svg"), svg); await writeFile(join(directorySource, "README.md"), "Parity companion\n"); await writeFile(join(directorySource, ".tfsb-source-map.toml"), map().replace('include_trees = ["svg"]', 'include_trees = ["icons"]'));
    const archive = join(base, "source.zip"); await writeFile(archive, zipSync({ "parity.svg": Buffer.from(svg), "README.md": Buffer.from("Parity companion\n") }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    await importProject({ archive, root: archiveRoot, schema: 2, normalize: "exact-common", companions: ["README.md"] });
    await importProject({ source: { kind: "directory", path: directorySource }, root: directoryRoot, collections: ["terminal-nova-brand"], normalize: "exact-common", companions: ["README.md"] });
    for (const path of ["project.toml", "assets/parity.toml", "companions/README.md"]) expect(await readFile(join(directoryRoot, ".tfsb", path))).toEqual(await readFile(join(archiveRoot, ".tfsb", path)));
    expect(await readFile(join(directoryRoot, ".tfsb", "provenance.json"), "utf8")).not.toBe(await readFile(join(archiveRoot, ".tfsb", "provenance.json"), "utf8"));
  });
});
