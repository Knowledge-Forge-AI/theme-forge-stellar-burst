import { access, link, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  disposeImportPlan,
  executeImport,
  getDirectorySnapshotCapability,
  importProject,
  parseAssetTomlV2,
  parseImportProvenanceV3,
  parseSourceMap,
  planImport,
  planShard,
  serializeShardManifest,
  serializeSvgV2,
} from "../src/index.js";
import { makeTempDir, readRepoFile, unwrap } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function workspace(): string {
  const value = realpathSync(makeTempDir("tfsb-directory-import-"));
  roots.push(value);
  return value;
}

function canonicalSvg(): string {
  const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml")));
  return unwrap(serializeSvgV2(asset.svg));
}

function sourceMap(extra = ""): string {
  return `schema_version = 1
source_root = "."

[[collection]]
id = "icons"
name = "Icons"
root = "."
identity = "basename"
prefix = ""
include_paths = []
include_trees = ["icons"]
exclude_paths = []
exclude_trees = []
${extra}`;
}

async function fixture(options: { readonly normalized?: boolean; readonly companion?: boolean } = {}) {
  const base = workspace();
  const source = join(base, "source");
  const root = join(base, "project");
  await mkdir(join(source, "icons"), { recursive: true });
  await mkdir(root);
  const svg = options.normalized === true
    ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Directory title</title><path d="M0 0L1 1"/></svg>'
    : canonicalSvg();
  await writeFile(join(source, "icons", "direct.svg"), svg);
  await writeFile(join(source, ".tfsb-source-map.toml"), sourceMap());
  if (options.companion === true) await writeFile(join(source, "README.md"), "Synthetic brand terms\n");
  return { base, source, root, svg };
}

const nativeAvailable = getDirectorySnapshotCapability(realpathSync(tmpdir())).supported;

describe.runIf(nativeAvailable)("authenticated directory import", () => {
  it("materializes validated shard evidence through the authenticated directory import path", async () => {
    const value = await fixture({ companion: true });
    const map = unwrap(parseSourceMap(sourceMap()));
    const shard = unwrap(await planShard(value.source, map, "icons", ["icons/direct.svg"]));
    const manifestPath = join(value.base, "shard.toml");
    await writeFile(manifestPath, serializeShardManifest(shard));

    const plan = await importProject({
      source: { kind: "directory", path: value.source },
      root: value.root,
      shardManifest: manifestPath,
      companions: ["README.md"],
    });
    expect(plan.assets.map((asset) => asset.id)).toEqual(["direct"]);
    expect(plan.collections).toEqual(["icons"]);
    expect(await readFile(join(value.root, ".tfsb", "companions", "README.md"), "utf8")).toBe("Synthetic brand terms\n");
  });

  it("fails shard-backed import closed on stale bytes, selection conflicts, and manifest races", async () => {
    const stale = await fixture();
    const staleShard = unwrap(await planShard(stale.source, unwrap(parseSourceMap(sourceMap())), "icons", ["icons/direct.svg"]));
    const staleManifest = join(stale.base, "stale.toml");
    await writeFile(staleManifest, serializeShardManifest(staleShard));
    await writeFile(join(stale.source, "icons", "direct.svg"), canonicalSvg().replace('r="8"', 'r="7"'));
    await expect(importProject({ source: { kind: "directory", path: stale.source }, root: stale.root, shardManifest: staleManifest }))
      .rejects.toMatchObject({ diagnostic: { code: "SHARD_MANIFEST_STALE" } });

    const conflict = await fixture();
    const conflictShard = unwrap(await planShard(conflict.source, unwrap(parseSourceMap(sourceMap())), "icons", ["icons/direct.svg"]));
    const conflictManifest = join(conflict.base, "conflict.toml");
    await writeFile(conflictManifest, serializeShardManifest(conflictShard));
    await expect(planImport({ source: { kind: "directory", path: conflict.source }, root: conflict.root, shardManifest: conflictManifest, selections: ["icons/direct.svg"] }))
      .rejects.toMatchObject({ diagnostic: { code: "SHARD_MANIFEST_SELECTION_CONFLICT" } });

    const raced = await fixture();
    const racedShard = unwrap(await planShard(raced.source, unwrap(parseSourceMap(sourceMap())), "icons", ["icons/direct.svg"]));
    const racedManifest = join(raced.base, "raced.toml");
    await writeFile(racedManifest, serializeShardManifest(racedShard));
    const racedPlan = await planImport({ source: { kind: "directory", path: raced.source }, root: raced.root, shardManifest: racedManifest });
    await writeFile(racedManifest, `${serializeShardManifest(racedShard)}\n`);
    await expect(executeImport(racedPlan)).rejects.toMatchObject({ diagnostic: { code: "SHARD_MANIFEST_CHANGED" } });
  });

  it("imports direct schema-2 assets and an exact opaque companion with truthful provenance 3", async () => {
    const { source, root } = await fixture({ companion: true });
    const plan = await importProject({ source: { kind: "directory", path: source }, root, collections: ["icons"], companions: ["README.md"] });
    expect(plan).toMatchObject({ sourceKind: "directory", provenanceSchemaVersion: 3, collections: ["icons"], sourceMapDescription: ".tfsb-source-map.toml" });
    expect(plan.assets).toHaveLength(1);
    expect(plan.assets[0]).toMatchObject({ id: "direct", filename: "direct.svg", schemaVersion: 2 });
    expect(await readFile(join(root, ".tfsb", "companions", "README.md"), "utf8")).toBe("Synthetic brand terms\n");
    const provenance = unwrap(parseImportProvenanceV3(await readFile(join(root, ".tfsb", "provenance.json"), "utf8")));
    expect(provenance.records).toHaveLength(2);
    expect(provenance.records[0]).toMatchObject({ type: "asset", assetId: "direct", source: { kind: "directory", collectionId: "icons", sourcePath: "icons/direct.svg", sourceState: "present", canonicalState: "present", resolution: "aligned", toolVersion: "0.5.0" }, migration: null, normalizationPolicy: null });
    expect(provenance.records[1]).toMatchObject({ type: "companion", canonicalPath: ".tfsb/companions/README.md", source: { kind: "directory", sourcePath: "README.md", sourceCanonicalBasis: "tfsb-companion-bytes-v1" } });
    expect((provenance.records[0] as any).source.sourceMapDigest).toBe((provenance.records[1] as any).source.sourceMapDigest);
    expect((provenance.records[0] as any).source.snapshotDigest).toBe((provenance.records[1] as any).source.snapshotDigest);
  });

  it("normalizes exact-common input and records only the consumed policy on the asset", async () => {
    const { base, source, root } = await fixture({ normalized: true });
    const normalizationMap = join(base, "normalization.toml");
    await writeFile(normalizationMap, "schema_version = 1\n");
    const plan = await importProject({ source: { kind: "directory", path: source }, root, collections: ["icons"], normalize: "exact-common", normalizationMap });
    expect(plan.normalizationLedger?.entries[0]).toMatchObject({ source: "icons/direct.svg", disposition: "normalized", operations: expect.arrayContaining(["title_only_to_labelled"]) });
    const provenance = unwrap(parseImportProvenanceV3(await readFile(join(root, ".tfsb", "provenance.json"), "utf8")));
    expect(provenance.records[0]).toMatchObject({ normalizationPolicy: { policyBasis: "tfsb-normalization-policy-v1", implementationVersion: "0.5.0" }, source: { sourceCanonicalDigest: expect.stringMatching(/^sha256:/), canonicalDigest: expect.stringMatching(/^sha256:/) } });
  });

  it("keeps archive canonical and provenance bytes identical through compatibility and typed source routing", async () => {
    const base = workspace();
    const left = join(base, "left", "project");
    const right = join(base, "right", "project");
    await mkdir(left, { recursive: true });
    await mkdir(right, { recursive: true });
    const archive = join(base, "source.zip");
    await writeFile(archive, zipSync({ "direct.svg": Buffer.from(canonicalSvg()) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    const compatible = await importProject({ archive, root: left, schema: 2, recordProvenance: true });
    const typed = await importProject({ source: { kind: "archive", path: archive }, root: right, schema: 2, recordProvenance: true });
    expect(compatible.sourceKind).toBe("archive");
    expect(typed.sourceKind).toBe("archive");
    expect([...compatible.files].map(([path, bytes]) => [path, Buffer.from(bytes).toString("hex")])).toEqual([...typed.files].map(([path, bytes]) => [path, Buffer.from(bytes).toString("hex")]));
  });

  it("bounds a collection larger than the mutation ceiling through exact selection", async () => {
    const { source, root } = await fixture();
    const svg = canonicalSvg();
    await Promise.all(Array.from({ length: 128 }, (_, index) => writeFile(join(source, "icons", `extra-${index}.svg`), svg)));
    await expect(importProject({ source: { kind: "directory", path: source }, root, collections: ["icons"] })).rejects.toMatchObject({ diagnostic: { code: "RESOURCE_LIMIT_EXCEEDED" } });
    const allPaths = ["icons/direct.svg", ...Array.from({ length: 128 }, (_, index) => `icons/extra-${index}.svg`)];
    await expect(importProject({ source: { kind: "directory", path: source }, root, collections: ["icons"], selections: allPaths })).rejects.toMatchObject({ diagnostic: { code: "RESOURCE_LIMIT_EXCEEDED" } });
    const plan = await importProject({ source: { kind: "directory", path: source }, root, collections: ["icons"], selections: ["icons/direct.svg"] });
    expect(plan.assets.map((asset) => asset.id)).toEqual(["direct"]);
  });

  it("blocks unsafe, unsupported, and unowned normalization before any canonical write", async () => {
    for (const [svg, code] of [
      ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><use href="https://example.invalid/x.svg#g"/></svg>', "IMPORT_UNSAFE_SOURCE"],
      ['<svg xmlns="http://www.w3.org/2000/svg" id="seed" viewBox="0 0 1 1"><path d="M0 0L1 1"/></svg>', "IMPORT_UNSUPPORTED_SOURCE"],
      ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>Needs normalization</title><path d="M0 0L1 1"/></svg>', "IMPORT_NORMALIZATION_REQUIRED"],
    ] as const) {
      const value = await fixture(); await writeFile(join(value.source, "icons", "direct.svg"), svg);
      await expect(importProject({ source: { kind: "directory", path: value.source }, root: value.root, collections: ["icons"] })).rejects.toMatchObject({ diagnostic: { code } });
      await expect(access(join(value.root, ".tfsb"))).rejects.toThrow();
    }
  });

  it("fails closed on source-map identity collision, overlong identity, exclusion, and cross-collection ownership", async () => {
    const collision = await fixture(); await mkdir(join(collision.source, "icons", "nested")); await writeFile(join(collision.source, "icons", "nested", "direct.svg"), canonicalSvg());
    await expect(importProject({ source: { kind: "directory", path: collision.source }, root: collision.root, collections: ["icons"] })).rejects.toMatchObject({ diagnostic: { code: "SOURCE_IDENTITY_COLLISION" } });

    const overlong = await fixture(); await unlink(join(overlong.source, "icons", "direct.svg")); await writeFile(join(overlong.source, "icons", `${"a".repeat(65)}.svg`), canonicalSvg());
    await expect(importProject({ source: { kind: "directory", path: overlong.source }, root: overlong.root, collections: ["icons"] })).rejects.toMatchObject({ diagnostic: { code: "SOURCE_IDENTITY_TOO_LONG" } });

    const excluded = await fixture(); await writeFile(join(excluded.source, ".tfsb-source-map.toml"), sourceMap().replace("exclude_paths = []", 'exclude_paths = ["icons/direct.svg"]'));
    await expect(importProject({ source: { kind: "directory", path: excluded.source }, root: excluded.root, collections: ["icons"], selections: ["icons/direct.svg"] })).rejects.toBeDefined();

    const owned = await fixture(); await writeFile(join(owned.source, ".tfsb-source-map.toml"), `${sourceMap()}\n[[collection]]\nid = "second"\nname = "Second"\nroot = "."\nidentity = "basename"\nprefix = "second-"\ninclude_paths = []\ninclude_trees = ["icons"]\nexclude_paths = []\nexclude_trees = []\n`);
    await expect(importProject({ source: { kind: "directory", path: owned.source }, root: owned.root, collections: ["icons", "second"] })).rejects.toMatchObject({ diagnostic: { code: "SOURCE_PATH_MULTIPLE_COLLECTIONS" } });
  });

  it("rejects selected symlinks and hard links at the import layer", async () => {
    const symlinked = await fixture(); await unlink(join(symlinked.source, "icons", "direct.svg")); await writeFile(join(symlinked.source, "icons", "target.svg"), canonicalSvg()); await symlink("target.svg", join(symlinked.source, "icons", "direct.svg"));
    await expect(importProject({ source: { kind: "directory", path: symlinked.source }, root: symlinked.root, collections: ["icons"] })).rejects.toBeDefined();
    const hardLinked = await fixture(); await link(join(hardLinked.source, "icons", "direct.svg"), join(hardLinked.source, "second-link"));
    await expect(importProject({ source: { kind: "directory", path: hardLinked.source }, root: hardLinked.root, collections: ["icons"] })).rejects.toMatchObject({ diagnostic: { code: "DIRECTORY_HARD_LINK" } });
  });

  it("requires a source map and refuses an initialized canonical target", async () => {
    const missing = await fixture(); await unlink(join(missing.source, ".tfsb-source-map.toml"));
    await expect(importProject({ source: { kind: "directory", path: missing.source }, root: missing.root, collections: ["icons"] })).rejects.toMatchObject({ diagnostic: { code: "SOURCE_MAP_REQUIRED" } });
    const initialized = await fixture(); const archive = join(initialized.base, "initial.zip"); await writeFile(archive, zipSync({ "initial.svg": Buffer.from(canonicalSvg()) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") })); await importProject({ archive, root: initialized.root, schema: 2 });
    await expect(importProject({ source: { kind: "directory", path: initialized.source }, root: initialized.root, collections: ["icons"] })).rejects.toMatchObject({ diagnostic: { code: "ROOT_ALREADY_INITIALIZED" } });
  });

  it("disposes dry-run authority without zeroing inspectable companion bytes", async () => {
    const { source, root } = await fixture({ companion: true });
    const plan = await importProject({ source: { kind: "directory", path: source }, root, collections: ["icons"], companions: ["README.md"], dryRun: true });
    expect(Buffer.from(plan.companions[0]!.bytes).toString("utf8")).toBe("Synthetic brand terms\n");
    await expect(executeImport(plan)).rejects.toMatchObject({ diagnostic: { code: "DIRECTORY_SNAPSHOT_CLOSED" } });
    await expect(access(join(root, ".tfsb"))).rejects.toThrow();
  });

  it("rejects a forged public directory plan", async () => {
    const { source, root } = await fixture();
    const plan = await planImport({ source: { kind: "directory", path: source }, root, collections: ["icons"] });
    await expect(executeImport({ ...plan })).rejects.toMatchObject({ diagnostic: { code: "DIRECTORY_IMPORT_PLAN_FORGED" } });
    disposeImportPlan(plan);

    const second = await fixture();
    const tampered = await planImport({ source: { kind: "directory", path: second.source }, root: second.root, collections: ["icons"] });
    (tampered as { sourceKind: "archive" | "directory" }).sourceKind = "archive";
    await expect(executeImport(tampered)).rejects.toMatchObject({ diagnostic: { code: "DIRECTORY_IMPORT_PLAN_FORGED" } });
    await expect(access(join(second.root, ".tfsb"))).rejects.toThrow();
  });

  it("revalidates source bytes, companions, source-map semantics, and target absence before promotion", async () => {
    for (const [mutate, code] of [
      [async (fixtureValue: Awaited<ReturnType<typeof fixture>>) => writeFile(join(fixtureValue.source, "icons", "direct.svg"), `${fixtureValue.svg} `), "DIRECTORY_SOURCE_CHANGED"],
      [async (fixtureValue: Awaited<ReturnType<typeof fixture>>) => writeFile(join(fixtureValue.source, "README.md"), "changed\n"), "DIRECTORY_SOURCE_CHANGED"],
      [async (fixtureValue: Awaited<ReturnType<typeof fixture>>) => writeFile(join(fixtureValue.source, ".tfsb-source-map.toml"), sourceMap().replace('prefix = ""', 'prefix = "changed-"')), "SOURCE_MAP_CHANGED"],
    ] as const) {
      const value = await fixture({ companion: true });
      const plan = await planImport({ source: { kind: "directory", path: value.source }, root: value.root, collections: ["icons"], companions: ["README.md"] });
      await mutate(value);
      await expect(executeImport(plan)).rejects.toMatchObject({ diagnostic: { code } });
      await expect(access(join(value.root, ".tfsb"))).rejects.toThrow();
    }
    const targetRace = await fixture();
    const plan = await planImport({ source: { kind: "directory", path: targetRace.source }, root: targetRace.root, collections: ["icons"] });
    await expect(executeImport(plan, { afterStageWrite: async () => { await mkdir(join(targetRace.root, ".tfsb")); } })).rejects.toMatchObject({ diagnostic: { code: "PROJECT_ASSETS_MISSING" } });
  });

  it("allows a formatting-only canonical source-map rewrite when it is outside the traversed view", async () => {
    const { source, root } = await fixture();
    const plan = await planImport({ source: { kind: "directory", path: source }, root, collections: ["icons"] });
    await writeFile(join(source, ".tfsb-source-map.toml"), `# formatting only\n${sourceMap()}`);
    await executeImport(plan);
    await access(join(root, ".tfsb", "provenance.json"));
  });

  it.each([
    [{}, "DIRECTORY_COLLECTION_REQUIRED"],
    [{ collections: ["missing"] }, "DIRECTORY_UNKNOWN_COLLECTION"],
    [{ collections: ["icons", "icons"] }, "DIRECTORY_DUPLICATE_COLLECTION"],
    [{ collections: ["icons"], schema: 1 as const }, "DIRECTORY_SCHEMA_UNSUPPORTED"],
    [{ collections: ["icons"], manifest: true }, "DIRECTORY_MANIFEST_UNSUPPORTED"],
    [{ collections: ["icons"], selections: ["icons/missing.svg"] }, "DIRECTORY_UNKNOWN_SELECTION"],
  ])("fails closed for invalid directory authority %#", async (extra, code) => {
    const { source, root } = await fixture();
    await expect(importProject({ source: { kind: "directory", path: source }, root, ...extra })).rejects.toMatchObject({ diagnostic: { code } });
    await expect(access(join(root, ".tfsb"))).rejects.toThrow();
  });
});
