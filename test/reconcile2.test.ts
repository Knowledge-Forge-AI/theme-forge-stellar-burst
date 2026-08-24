import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { diffProject, importProject, mapReconcileJson, reconcileProject } from "../src/index.js";
import { makeTempDir } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function root(): string { const value = makeTempDir("tfsb-reconcile2-"); roots.push(value); return value; }
async function zip(base: string, name: string, svg: string): Promise<string> { const path = join(base, name); await writeFile(path, zipSync({ "icons/a.svg": Buffer.from(svg) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") })); return path; }
const source = (d: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="${d}"/></svg>`;

describe("schema-2 paired-checkpoint reconciliation", () => {
  it("accepts unchanged raw normalized source without the map and blocks changed source until exact authority is re-supplied", async () => {
    const base = root(); const original = await zip(base, "original.zip", source("M0 0L1 1"));
    const map = join(base, "map.toml"); await writeFile(map, 'schema_version = 1\n\n[[entry]]\nsource = "icons/a.svg"\naccessibility = "consumer_labelled"\n');
    await importProject({ archive: original, root: base, schema: 2, normalize: "exact-common", normalizationMap: map });
    const unchanged = await reconcileProject({ archive: original, root: base });
    expect(unchanged).toMatchObject({ changed: false, blocked: false, applied: false });
    expect(unchanged.records[0]?.classification).toBe("UNCHANGED");

    const changed = await zip(base, "changed.zip", source("M0 0L2 2"));
    const missing = await reconcileProject({ archive: changed, root: base });
    expect(missing).toMatchObject({ blocked: true, applied: false });
    expect(missing.records[0]?.classification).toBe("POLICY_AUTHORITY_REQUIRED");

    const equivalent = join(base, "equivalent.toml"); await writeFile(equivalent, '# comment\nschema_version = 1\n[[entry]]\naccessibility = "consumer_labelled"\nsource = "icons/a.svg"\n');
    const applied = await reconcileProject({ archive: changed, root: base, normalize: "exact-common", normalizationMap: equivalent, apply: true });
    expect(applied).toMatchObject({ blocked: false, changed: true, applied: true });
    expect(applied.records[0]?.classification).toBe("ARCHIVE_CHANGED");
    expect(applied).toMatchObject({ normalizationPolicy: { policyBasis: "tfsb-normalization-policy-v1" }, normalizationLedger: { schemaVersion: 1, entries: [{ source: "icons/a.svg", disposition: "normalized" }] } });
    expect(mapReconcileJson(applied)).toMatchObject({ normalizationPolicy: { policyBasis: "tfsb-normalization-policy-v1" }, normalizationLedger: { entries: [{ source: "icons/a.svg" }] } });
  });

  it("rejects semantically changed authority and detects canonical-edit plus changed-source conflict", async () => {
    const base = root(); const original = await zip(base, "original.zip", source("M0 0L1 1"));
    const map = join(base, "map.toml"); await writeFile(map, 'schema_version = 1\n[defaults]\nunlabelled_mode = "consumer_labelled"\n');
    await importProject({ archive: original, root: base, schema: 2, normalize: "exact-common", normalizationMap: map });
    const changed = await zip(base, "changed.zip", source("M0 0L2 2"));
    const semanticChange = join(base, "changed-map.toml"); await writeFile(semanticChange, 'schema_version = 1\n[defaults]\nunlabelled_mode = "decorative"\n');
    expect((await reconcileProject({ archive: changed, root: base, normalize: "exact-common", normalizationMap: semanticChange })).records[0]?.classification).toBe("POLICY_AUTHORITY_REQUIRED");

    const assetPath = join(base, ".tfsb", "assets", "a.toml");
    const canonical = await readFile(assetPath, "utf8"); await writeFile(assetPath, canonical.replace('d = "M0 0L1 1"', 'd = "M0 0L3 3"'));
    const conflict = await reconcileProject({ archive: changed, root: base, normalize: "exact-common", normalizationMap: map });
    expect(conflict).toMatchObject({ blocked: true, applied: false });
    expect(conflict.records[0]?.classification).toBe("CONFLICT");
  });

  it("reports raw-source and normalized-semantic archive truth independently", async () => {
    const base = root(); const original = await zip(base, "original.zip", source("M0 0L1 1"));
    const map = join(base, "map.toml"); await writeFile(map, 'schema_version = 1\n[defaults]\nunlabelled_mode = "decorative"\n');
    await importProject({ archive: original, root: base, schema: 2, normalize: "exact-common", normalizationMap: map });
    const unchanged = await diffProject({ root: base, baseline: "archive", archive: original });
    expect(unchanged).toMatchObject({ baseline: "archive", different: false, changes: [], sourceRelations: [{ key: "asset:a", rawRelation: "unchanged", normalizationRelation: "normalized", semanticComparison: "unchanged" }] });
    const changed = await zip(base, "changed.zip", source("M0 0L2 2"));
    const result = await diffProject({ root: base, baseline: "archive", archive: changed });
    expect(result).toMatchObject({ baseline: "archive", different: true, changes: [], sourceRelations: [{ key: "asset:a", rawRelation: "changed", normalizationRelation: "authority_required", semanticComparison: "unavailable" }] });
  });

  it("honors explicit resolution when archive candidate matches archive baseline but canonical was edited", async () => {
    const base = root();
    const original = await zip(base, "original.zip", source("M0 0L1 1"));
    const map = join(base, "map.toml");
    await writeFile(map, 'schema_version = 1\n[defaults]\nunlabelled_mode = "consumer_labelled"\n');
    await importProject({ archive: original, root: base, schema: 2, normalize: "exact-common", normalizationMap: map });

    // Local canonical edit
    const assetPath = join(base, ".tfsb", "assets", "a.toml");
    const canonical = await readFile(assetPath, "utf8");
    await writeFile(assetPath, canonical.replace('d = "M0 0L1 1"', 'd = "M0 0L3 3"'));

    // Archive change that normalizes to the SAME model as original archive baseline (formatting change)
    const formatted = await zip(base, "formatted.zip", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0  0 10 10"><path d="M0 0L1 1"/></svg>');

    // Without resolution: CONFLICT
    const noResolve = await reconcileProject({ archive: formatted, root: base, normalize: "exact-common", normalizationMap: map });
    expect(noResolve).toMatchObject({ blocked: true, applied: false });
    expect(noResolve.records[0]?.classification).toBe("CONFLICT");

    // With --resolve asset:a=archive
    const resolveArchive = await reconcileProject({ archive: formatted, root: base, normalize: "exact-common", normalizationMap: map, resolutions: ["asset:a=archive"] });
    expect(resolveArchive).toMatchObject({ blocked: false });
    expect(resolveArchive.records[0]?.classification).toBe("ARCHIVE_CHANGED");

    // With --resolve asset:a=canonical
    const resolveCanon = await reconcileProject({ archive: formatted, root: base, normalize: "exact-common", normalizationMap: map, resolutions: ["asset:a=canonical"] });
    expect(resolveCanon).toMatchObject({ blocked: false });
    expect(resolveCanon.records[0]?.classification).toBe("CONFLICT");
  });

  it("handles deleted canonical asset and companion when resolving to canonical without throwing", async () => {
    const base = root();
    const archivePath = join(base, "source.zip");
    await writeFile(archivePath, zipSync({
      "icons/a.svg": Buffer.from(source("M0 0L1 1")),
      "README.md": Buffer.from("Initial readme"),
    }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    const map = join(base, "map.toml");
    await writeFile(map, 'schema_version = 1\n[defaults]\nunlabelled_mode = "consumer_labelled"\n');
    await importProject({ archive: archivePath, root: base, schema: 2, normalize: "exact-common", normalizationMap: map, companions: ["README.md"] });

    // Delete both locally
    await rm(join(base, ".tfsb", "assets", "a.toml"));
    await rm(join(base, ".tfsb", "companions", "README.md"));

    // Archive changed
    const changedArchive = join(base, "changed.zip");
    await writeFile(changedArchive, zipSync({
      "icons/a.svg": Buffer.from(source("M0 0L2 2")),
      "README.md": Buffer.from("Updated readme"),
    }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));

    const resolved = await reconcileProject({
      archive: changedArchive,
      root: base,
      normalize: "exact-common",
      normalizationMap: map,
      companions: ["README.md"],
      resolutions: ["asset:a=canonical", "companion:README.md=canonical"],
    });
    expect(resolved.blocked).toBe(false);
  });
});
