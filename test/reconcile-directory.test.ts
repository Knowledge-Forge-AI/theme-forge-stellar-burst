import { access, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";

import { getDirectorySnapshotCapability, importProject, parseAssetTomlV2, parseSourceMap, parseSvgV2, planShard, serializeAssetTomlV2, serializeShardManifest, serializeSvgV2 } from "../src/index.js";
import {
  executeDirectoryReconciliationPlan,
  planDirectoryReconciliation,
  reconcileDirectoryProject,
  type DirectoryReconciliationOptions,
} from "../src/reconcile-directory.js";
import { parseImportProvenanceV3 } from "../src/provenance3.js";
import { makeTempDir, readRepoFile, unwrap } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const nativeAvailable = getDirectorySnapshotCapability(realpathSync(tmpdir())).supported;

function sourceSvg(pathData = "M0 0L1 1"): string {
  const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml"))).svg;
  const path = { type: "path", d: pathData } as unknown as (typeof asset.elements)[number];
  return unwrap(serializeSvgV2({ ...asset, elements: [...asset.elements, path] }));
}

function sourceMap(prefix = ""): string {
  return `schema_version = 1\nsource_root = "."\n\n[[collection]]\nid = "icons"\nname = "Icons"\nroot = "icons"\nidentity = "basename"\nprefix = "${prefix}"\ninclude_paths = []\ninclude_trees = ["."]\nexclude_paths = []\nexclude_trees = []\n`;
}

async function fixture(): Promise<{ readonly base: string; readonly source: string; readonly root: string; readonly asset: string; readonly options: DirectoryReconciliationOptions }> {
  const base = realpathSync(makeTempDir("tfsb-directory-reconcile-"));
  roots.push(base);
  const source = join(base, "source");
  const root = join(base, "project");
  const asset = join(source, "icons", "asset.svg");
  await mkdir(join(source, "icons"), { recursive: true });
  await mkdir(root);
  await writeFile(asset, sourceSvg());
  await writeFile(join(source, ".tfsb-source-map.toml"), sourceMap());
  await importProject({ source: { kind: "directory", path: source }, root, collections: ["icons"] });
  return { base, source, root, asset, options: { directory: source, root, sourceMap: join(source, ".tfsb-source-map.toml"), collections: ["icons"] } };
}

async function companionFixture() {
  const base = realpathSync(makeTempDir("tfsb-directory-companion-"));
  roots.push(base);
  const source = join(base, "source");
  const root = join(base, "project");
  const asset = join(source, "icons", "asset.svg");
  const companion = join(source, "icons", "README.md");
  await mkdir(join(source, "icons"), { recursive: true });
  await mkdir(root);
  await writeFile(asset, sourceSvg());
  await writeFile(companion, "Legal v1\n");
  await writeFile(join(source, ".tfsb-source-map.toml"), sourceMap());
  await importProject({ source: { kind: "directory", path: source }, root, collections: ["icons"], companions: ["icons/README.md"] });
  return { source, root, companion, options: { directory: source, root, sourceMap: join(source, ".tfsb-source-map.toml"), collections: ["icons"] } satisfies DirectoryReconciliationOptions };
}

describe.runIf(nativeAvailable)("authenticated directory reconciliation", () => {
  it("plans unchanged state and rejects copied public plans with the exact code", async () => {
    const value = await fixture();
    const plan = await planDirectoryReconciliation(value.options);
    expect(plan.blocked).toBe(false);
    expect(plan.records).toMatchObject([{ classification: "UNCHANGED" }]);
    await expect(executeDirectoryReconciliationPlan({ ...plan })).rejects.toMatchObject({ diagnostic: { code: "RECONCILE_INVALID_PLAN" } });
    await executeDirectoryReconciliationPlan(plan);
    await access(join(value.root, ".tfsb", "project.toml"));
  });

  it("updates source changes, records formatting-only changes, and preserves omission", async () => {
    const changed = await fixture();
    await writeFile(changed.asset, sourceSvg("M0 0L2 2"));
    const sourcePlan = await planDirectoryReconciliation(changed.options);
    expect(sourcePlan.records[0]?.classification).toBe("SOURCE_CHANGED");
    await executeDirectoryReconciliationPlan(sourcePlan);
    expect((await readFile(join(changed.root, ".tfsb", "assets", "asset.toml"), "utf8")).includes("M0 0L2 2")).toBe(true);

    const formatting = await fixture();
    await writeFile(formatting.asset, `${await readFile(formatting.asset, "utf8")}\n`);
    const formattingPlan = await planDirectoryReconciliation(formatting.options);
    expect(formattingPlan.records[0]?.classification).toBe("SOURCE_FORMATTING_ONLY");
    await executeDirectoryReconciliationPlan(formattingPlan);

    const omitted = await fixture();
    await unlink(omitted.asset);
    const omissionPlan = await planDirectoryReconciliation(omitted.options);
    expect(omissionPlan.records[0]?.classification).toBe("SOURCE_OMISSION");
    await executeDirectoryReconciliationPlan(omissionPlan);
    const provenance = JSON.parse(await readFile(join(omitted.root, ".tfsb", "provenance.json"), "utf8")) as unknown;
    const parsed = unwrap(parseImportProvenanceV3(JSON.stringify(provenance)));
    expect(parsed.records[0]).toMatchObject({ source: { kind: "directory", sourceState: "absent" } });
  });

  it("fails closed for canonical-only and both-sided edits until exact source/canonical resolution", async () => {
    const canonical = await fixture();
    const canonicalPath = join(canonical.root, ".tfsb", "assets", "asset.toml");
    await writeFile(canonicalPath, (await readFile(canonicalPath, "utf8")).replace("M0 0L1 1", "M0 0L3 3"));
    const canonicalPlan = await planDirectoryReconciliation(canonical.options);
    expect(canonicalPlan.records[0]?.classification).toBe("CANONICAL_CHANGED");
    expect(canonicalPlan.blocked).toBe(true);

    const resolved = await reconcileDirectoryProject({ ...canonical.options, resolutions: ["asset:asset=canonical"], apply: true });
    expect(resolved.applied).toBe(true);
    expect(resolved.records[0]?.classification).toBe("ACCEPTED_CANONICAL_DIVERGENCE");

    const both = await fixture();
    await writeFile(both.asset, sourceSvg("M0 0L2 2"));
    const bothPath = join(both.root, ".tfsb", "assets", "asset.toml");
    await writeFile(bothPath, (await readFile(bothPath, "utf8")).replace("M0 0L1 1", "M0 0L3 3"));
    const bothPlan = await planDirectoryReconciliation(both.options);
    expect(bothPlan.records[0]?.classification).toBe("BOTH_CHANGED");
    expect(bothPlan.blocked).toBe(true);
    await expect(reconcileDirectoryProject({ ...both.options, resolutions: ["asset=source"], apply: true })).resolves.toMatchObject({ applied: true });
  });

  it("requires map acceptance plus explicit rename when the source-map ID changes", async () => {
    const value = await fixture();
    await writeFile(join(value.source, ".tfsb-source-map.toml"), sourceMap("new-"));
    const blocked = await planDirectoryReconciliation(value.options);
    expect(blocked.records.some((record) => record.classification === "SOURCE_MAP_AUTHORITY_REQUIRED")).toBe(true);
    const accepted = await planDirectoryReconciliation({ ...value.options, acceptSourceMap: blocked.sourceMapDigest, renames: ["asset=icons/asset.svg"] });
    expect(accepted.records.some((record) => record.classification === "RENAME_REQUIRED" && !record.blocker)).toBe(true);
    await executeDirectoryReconciliationPlan(accepted);
    await access(join(value.root, ".tfsb", "assets", "new-asset.toml"));
  });

  it("rejects archive resolution vocabulary and companion rename/remove directives at this boundary", async () => {
    const value = await fixture();
    await expect(planDirectoryReconciliation({ ...value.options, resolutions: ["asset=archive"] })).rejects.toMatchObject({ diagnostic: { code: "RECONCILE_INVALID_DIRECTIVE" } });
    await expect(planDirectoryReconciliation({ ...value.options, companionRenames: ["README.md=README.txt"] } as DirectoryReconciliationOptions & { readonly companionRenames: readonly string[] })).rejects.toMatchObject({ diagnostic: { code: "RECONCILE_INVALID_DIRECTIVE" } });
  });

  it("lifts schema-2 archive provenance only with exact source-kind authority and preserves out-of-scope history", async () => {
    const base = realpathSync(makeTempDir("tfsb-directory-adoption-"));
    roots.push(base);
    const root = join(base, "project");
    const source = join(base, "source");
    await mkdir(root);
    await mkdir(join(source, "icons"), { recursive: true });
    const archive = join(base, "source.zip");
    await writeFile(archive, zipSync({
      "asset.svg": Buffer.from(sourceSvg()),
      "untouched.svg": Buffer.from(sourceSvg("M0 0L4 4")),
      "icons/README.md": Buffer.from("Synthetic legal companion\n"),
    }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    await importProject({ archive, root, schema: 2, recordProvenance: true, companions: ["icons/README.md"] });
    await writeFile(join(source, "icons", "asset.svg"), sourceSvg());
    await writeFile(join(source, "icons", "README.md"), "Synthetic legal companion\n");
    await writeFile(join(source, ".tfsb-source-map.toml"), sourceMap());
    const options: DirectoryReconciliationOptions = {
      directory: source,
      root,
      sourceMap: join(source, ".tfsb-source-map.toml"),
      collections: ["icons"],
      selectedPaths: ["icons/asset.svg"],
      companions: ["icons/README.md"],
    };

    const blocked = await planDirectoryReconciliation(options);
    expect(blocked.records.filter((record) => record.classification === "SOURCE_KIND_AUTHORITY_REQUIRED")).toHaveLength(2);
    await expect(planDirectoryReconciliation({ ...options, acceptSourceKindChange: "directory=archive" }))
      .rejects.toMatchObject({ diagnostic: { code: "RECONCILE_INVALID_DIRECTIVE" } });
    const accepted = await reconcileDirectoryProject({ ...options, acceptSourceKindChange: "archive=directory", apply: true });
    expect(accepted.applied).toBe(true);
    const provenance = unwrap(parseImportProvenanceV3(await readFile(join(root, ".tfsb", "provenance.json"), "utf8")));
    expect(provenance.records.find((record) => record.type === "asset" && record.assetId === "asset")).toMatchObject({ source: { kind: "directory", sourcePath: "icons/asset.svg" } });
    expect(provenance.records.find((record) => record.type === "asset" && record.assetId === "untouched")).toMatchObject({ source: { kind: "archive" } });
    expect(provenance.records.find((record) => record.type === "companion")).toMatchObject({ source: { kind: "directory", sourcePath: "icons/README.md" } });
  });

  it("rejects source, canonical, source-map, and staged-tree races with exact closed codes", async () => {
    const sourceRace = await fixture();
    await writeFile(sourceRace.asset, sourceSvg("M0 0L2 2"));
    const sourcePlan = await planDirectoryReconciliation(sourceRace.options);
    await writeFile(sourceRace.asset, sourceSvg("M0 0L3 3"));
    await expect(executeDirectoryReconciliationPlan(sourcePlan)).rejects.toMatchObject({ diagnostic: { code: "DIRECTORY_SOURCE_CHANGED" } });

    const canonicalRace = await fixture();
    await writeFile(canonicalRace.asset, sourceSvg("M0 0L2 2"));
    const canonicalPlan = await planDirectoryReconciliation(canonicalRace.options);
    const canonicalPath = join(canonicalRace.root, ".tfsb", "assets", "asset.toml");
    await writeFile(canonicalPath, (await readFile(canonicalPath, "utf8")).replace("M0 0L1 1", "M0 0L4 4"));
    await expect(executeDirectoryReconciliationPlan(canonicalPlan)).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });

    const mapRace = await fixture();
    await writeFile(mapRace.asset, sourceSvg("M0 0L2 2"));
    const mapPlan = await planDirectoryReconciliation(mapRace.options);
    await writeFile(join(mapRace.source, ".tfsb-source-map.toml"), `${sourceMap()}\n`);
    await expect(executeDirectoryReconciliationPlan(mapPlan)).rejects.toMatchObject({ diagnostic: { code: "SOURCE_MAP_CHANGED" } });

    const stageRace = await fixture();
    await writeFile(stageRace.asset, sourceSvg("M0 0L2 2"));
    const before = await readFile(join(stageRace.root, ".tfsb", "assets", "asset.toml"), "utf8");
    const stagePlan = await planDirectoryReconciliation(stageRace.options);
    await expect(executeDirectoryReconciliationPlan(stagePlan, { afterStageWrite: async () => {
      const stage = (await readdir(stageRace.root)).find((name) => name.startsWith(".tfsb-stage-"));
      expect(stage).toBeDefined();
      await writeFile(join(stageRace.root, stage!, "assets", "asset.toml"), "corrupt\n");
    } })).rejects.toMatchObject({ diagnostic: { code: "RECONCILE_STAGE_INVALID" } });
    expect(await readFile(join(stageRace.root, ".tfsb", "assets", "asset.toml"), "utf8")).toBe(before);
    expect((await readdir(stageRace.root)).filter((name) => name.startsWith(".tfsb-stage-") || name.startsWith(".tfsb-backup-") || name === ".tfsb.lock")).toEqual([]);
  });

  it("binds shard-manifest bytes for the lifetime of a reconcile plan", async () => {
    const value = await fixture();
    await writeFile(value.asset, sourceSvg("M0 0L2 2"));
    const map = unwrap(parseSourceMap(sourceMap()));
    const shard = unwrap(await planShard(value.source, map, "icons", ["asset.svg"]));
    const manifest = join(value.base, "shard.toml");
    await writeFile(manifest, serializeShardManifest(shard));
    const { collections: _collections, ...options } = value.options;
    const plan = await planDirectoryReconciliation({ ...options, shardManifest: manifest });
    await writeFile(manifest, `${serializeShardManifest(shard)}\n`);
    await expect(executeDirectoryReconciliationPlan(plan)).rejects.toMatchObject({ diagnostic: { code: "SHARD_MANIFEST_CHANGED" } });
  });

  it("requires exact normalization-policy acceptance and binds normalization-map bytes", async () => {
    const base = realpathSync(makeTempDir("tfsb-directory-policy-"));
    roots.push(base);
    const source = join(base, "source");
    const root = join(base, "project");
    const asset = join(source, "icons", "asset.svg");
    const mapPath = join(base, "normalization.toml");
    await mkdir(join(source, "icons"), { recursive: true });
    await mkdir(root);
    const raw = (d: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Asset title</title><path d="${d}"/></svg>`;
    await writeFile(asset, raw("M0 0L1 1"));
    await writeFile(join(source, ".tfsb-source-map.toml"), sourceMap());
    await writeFile(mapPath, 'schema_version = 1\n\n[[entry]]\nsource = "icons/asset.svg"\naccessibility = "consumer_labelled"\n');
    await importProject({ source: { kind: "directory", path: source }, root, collections: ["icons"], normalize: "exact-common", normalizationMap: mapPath });
    await writeFile(asset, raw("M0 0L2 2"));
    await writeFile(mapPath, 'schema_version = 1\n\n[[entry]]\nsource = "icons/asset.svg"\naccessibility = "decorative"\n');
    const options: DirectoryReconciliationOptions = { directory: source, root, sourceMap: join(source, ".tfsb-source-map.toml"), collections: ["icons"], normalize: "exact-common", normalizationMap: mapPath };
    const blocked = await planDirectoryReconciliation(options);
    expect(blocked.records[0]?.classification).toBe("POLICY_AUTHORITY_REQUIRED");
    await expect(planDirectoryReconciliation({ ...options, acceptNormalizationPolicy: `sha256:${"0".repeat(64)}` }))
      .rejects.toMatchObject({ diagnostic: { code: "POLICY_AUTHORITY_REQUIRED" } });
    const accepted = await planDirectoryReconciliation({ ...options, acceptNormalizationPolicy: blocked.normalizationPolicy!.policyDigest });
    await writeFile(mapPath, '# formatting rewrite\nschema_version = 1\n[[entry]]\naccessibility = "decorative"\nsource = "icons/asset.svg"\n');
    await expect(executeDirectoryReconciliationPlan(accepted)).rejects.toMatchObject({ diagnostic: { code: "NORMALIZATION_MAP_CHANGED" } });
  });

  it("covers new, converged, explicit rename/path-move, canonical resolution, and explicit removal transitions", async () => {
    const added = await fixture();
    await writeFile(join(added.source, "icons", "extra.svg"), sourceSvg("M0 0L2 2"));
    const addPlan = await planDirectoryReconciliation(added.options);
    expect(addPlan.records.some((record) => record.key === "asset:extra" && record.classification === "NEW_SOURCE")).toBe(true);
    await executeDirectoryReconciliationPlan(addPlan);
    await access(join(added.root, ".tfsb", "assets", "extra.toml"));

    const converged = await fixture();
    const convergedSource = sourceSvg("M0 0L5 5");
    await writeFile(converged.asset, convergedSource);
    const canonicalPath = join(converged.root, ".tfsb", "assets", "asset.toml");
    const priorAsset = unwrap(parseAssetTomlV2(await readFile(canonicalPath, "utf8")));
    const parsedSource = unwrap(parseSvgV2(convergedSource));
    await writeFile(canonicalPath, serializeAssetTomlV2({ ...priorAsset, svg: parsedSource }));
    const convergedBytes = await readFile(canonicalPath, "utf8");
    const convergedPlan = await planDirectoryReconciliation(converged.options);
    expect(convergedPlan.records[0]?.classification).toBe("CONVERGED");
    await executeDirectoryReconciliationPlan(convergedPlan);
    expect(await readFile(canonicalPath, "utf8")).toBe(convergedBytes);

    const canonical = await fixture();
    await writeFile(canonical.asset, sourceSvg("M0 0L2 2"));
    const canonicalAsset = join(canonical.root, ".tfsb", "assets", "asset.toml");
    await writeFile(canonicalAsset, (await readFile(canonicalAsset, "utf8")).replace("M0 0L1 1", "M0 0L7 7"));
    const locallyEdited = await readFile(canonicalAsset, "utf8");
    const canonicalResult = await reconcileDirectoryProject({ ...canonical.options, resolutions: ["asset=canonical"], apply: true });
    expect(canonicalResult.records[0]?.classification).toBe("ACCEPTED_CANONICAL_DIVERGENCE");
    expect(await readFile(canonicalAsset, "utf8")).toBe(locallyEdited);

    const renamed = await fixture();
    const renamedSource = join(renamed.source, "icons", "renamed.svg");
    await writeFile(renamedSource, await readFile(renamed.asset));
    await unlink(renamed.asset);
    const renamePlan = await planDirectoryReconciliation({ ...renamed.options, renames: ["asset=icons/renamed.svg"] });
    expect(renamePlan.records[0]).toMatchObject({ classification: "RENAME_REQUIRED", blocker: false, plannedAction: "rename" });
    await executeDirectoryReconciliationPlan(renamePlan);
    await expect(access(join(renamed.root, ".tfsb", "assets", "asset.toml"))).rejects.toThrow();
    await access(join(renamed.root, ".tfsb", "assets", "renamed.toml"));

    const moved = await fixture();
    await mkdir(join(moved.source, "icons", "nested"));
    const movedSource = join(moved.source, "icons", "nested", "asset.svg");
    await writeFile(movedSource, await readFile(moved.asset));
    await unlink(moved.asset);
    await reconcileDirectoryProject({ ...moved.options, renames: ["asset=icons/nested/asset.svg"], apply: true });
    const movedProvenance = unwrap(parseImportProvenanceV3(await readFile(join(moved.root, ".tfsb", "provenance.json"), "utf8")));
    expect(movedProvenance.records[0]).toMatchObject({ source: { sourcePath: "icons/nested/asset.svg" } });

    const removed = await fixture();
    const removePlan = await planDirectoryReconciliation({ ...removed.options, removals: ["asset"] });
    expect(removePlan.records[0]).toMatchObject({ classification: "REMOVE_REQUIRED", blocker: false });
    await executeDirectoryReconciliationPlan(removePlan);
    await expect(access(join(removed.root, ".tfsb", "assets", "asset.toml"))).rejects.toThrow();
  });

  it("reconciles tracked companion content and preserves omissions without structural grammar", async () => {
    const changed = await companionFixture();
    await writeFile(changed.companion, "Legal v2\n");
    const changedPlan = await planDirectoryReconciliation(changed.options);
    expect(changedPlan.records.find((record) => record.kind === "companion")?.classification).toBe("SOURCE_CHANGED");
    await executeDirectoryReconciliationPlan(changedPlan);
    expect(await readFile(join(changed.root, ".tfsb", "companions", "README.md"), "utf8")).toBe("Legal v2\n");

    const canonical = await companionFixture();
    const canonicalPath = join(canonical.root, ".tfsb", "companions", "README.md");
    await writeFile(canonicalPath, "Local legal edit\n");
    const blocked = await planDirectoryReconciliation(canonical.options);
    expect(blocked.records.find((record) => record.kind === "companion")).toMatchObject({ classification: "CANONICAL_CHANGED", blocker: true });
    await reconcileDirectoryProject({ ...canonical.options, resolutions: ["companion:README.md=canonical"], apply: true });
    expect(await readFile(canonicalPath, "utf8")).toBe("Local legal edit\n");

    const both = await companionFixture();
    await writeFile(both.companion, "Source legal edit\n");
    await writeFile(join(both.root, ".tfsb", "companions", "README.md"), "Canonical legal edit\n");
    expect((await planDirectoryReconciliation(both.options)).records.find((record) => record.kind === "companion"))
      .toMatchObject({ classification: "BOTH_CHANGED", blocker: true });

    const omitted = await companionFixture();
    await unlink(omitted.companion);
    const omissionPlan = await planDirectoryReconciliation(omitted.options);
    expect(omissionPlan.records.find((record) => record.kind === "companion")?.classification).toBe("SOURCE_OMISSION");
    await executeDirectoryReconciliationPlan(omissionPlan);
    expect(await readFile(join(omitted.root, ".tfsb", "companions", "README.md"), "utf8")).toBe("Legal v1\n");
  });

  it("never infers renames for equal-byte candidates without explicit authority", async () => {
    const value = await fixture();
    const newPath = join(value.source, "icons", "replacement.svg");
    await writeFile(newPath, await readFile(value.asset));
    await unlink(value.asset);
    const plan = await planDirectoryReconciliation(value.options);
    const omission = plan.records.find((record) => record.key === "asset:asset");
    const added = plan.records.find((record) => record.key === "asset:replacement");
    expect(omission).toMatchObject({ classification: "SOURCE_OMISSION", plannedAction: "retain" });
    expect(added).toMatchObject({ classification: "NEW_SOURCE", plannedAction: "add_canonical" });
  });

  it("rejects unknown, contradictory, and duplicate directives with exact diagnostic codes", async () => {
    const value = await fixture();
    // Unknown resolution
    await expect(planDirectoryReconciliation({ ...value.options, resolutions: ["asset:nonexistent=canonical"] }))
      .rejects.toMatchObject({ diagnostic: { code: "RECONCILE_UNKNOWN_RESOLUTION" } });
    // Unknown rename
    await expect(planDirectoryReconciliation({ ...value.options, renames: ["nonexistent=icons/asset.svg"] }))
      .rejects.toMatchObject({ diagnostic: { code: "RECONCILE_UNKNOWN_RENAME" } });
    // Unknown removal
    await expect(planDirectoryReconciliation({ ...value.options, removals: ["nonexistent"] }))
      .rejects.toMatchObject({ diagnostic: { code: "RECONCILE_UNKNOWN_REMOVAL" } });
    // Contradictory rename + remove
    await expect(planDirectoryReconciliation({ ...value.options, renames: ["asset=icons/asset.svg"], removals: ["asset"] }))
      .rejects.toMatchObject({ diagnostic: { code: "RECONCILE_CONTRADICTORY_DIRECTIVE" } });
    // Contradictory rename + resolve
    await expect(planDirectoryReconciliation({ ...value.options, renames: ["asset=icons/asset.svg"], resolutions: ["asset=canonical"] }))
      .rejects.toMatchObject({ diagnostic: { code: "RECONCILE_CONTRADICTORY_DIRECTIVE" } });
    // Duplicate remove
    await expect(planDirectoryReconciliation({ ...value.options, removals: ["asset", "asset"] }))
      .rejects.toMatchObject({ diagnostic: { code: "RECONCILE_DUPLICATE_DIRECTIVE" } });
    // Duplicate resolve
    await expect(planDirectoryReconciliation({ ...value.options, resolutions: ["asset=canonical", "asset=canonical"] }))
      .rejects.toMatchObject({ diagnostic: { code: "RECONCILE_DUPLICATE_DIRECTIVE" } });

    // Shard manifest directory required on archive import
    const archive = join(value.base, "source.zip");
    await writeFile(archive, zipSync({ "asset.svg": Buffer.from(sourceSvg()) }));
    await expect(importProject({ archive, root: join(value.base, "archive-root"), shardManifest: "dummy.toml" }))
      .rejects.toMatchObject({ diagnostic: { code: "SHARD_MANIFEST_DIRECTORY_REQUIRED" } });
  });
});

