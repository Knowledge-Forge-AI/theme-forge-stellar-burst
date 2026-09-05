import { access, mkdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeImport, getDirectorySnapshotCapability, parseAssetTomlV2, planImport, serializeSvgV2 } from "../src/index.js";
import { makeTempDir, readRepoFile, unwrap } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function canonicalSvg(): string { return unwrap(serializeSvgV2(unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml"))).svg)); }
function map(prefix = ""): string { return `schema_version = 1\nsource_root = "."\n\n[[collection]]\nid = "icons"\nname = "Icons"\nroot = "icons"\nidentity = "basename"\nprefix = "${prefix}"\ninclude_paths = []\ninclude_trees = ["."]\nexclude_paths = []\nexclude_trees = []\n`; }
async function fixture(companion = false) {
  const base = realpathSync(makeTempDir("tfsb-directory-race-")); roots.push(base);
  const source = join(base, "source"); const root = join(base, "project");
  await mkdir(join(source, "icons"), { recursive: true }); await mkdir(root);
  await writeFile(join(source, "icons", "asset.svg"), canonicalSvg()); await writeFile(join(source, ".tfsb-source-map.toml"), map());
  if (companion) await writeFile(join(source, "icons", "README.md"), "companion\n");
  return { base, source, root };
}
async function absent(root: string) { await expect(access(join(root, ".tfsb"))).rejects.toThrow(); }

const nativeAvailable = getDirectorySnapshotCapability(realpathSync(tmpdir())).supported;

describe.runIf(nativeAvailable)("directory import race revalidation", () => {
  it("rejects equal-byte recreation and selected-file symlink replacement", async () => {
    for (const replace of [
      async (path: string) => { const bytes = canonicalSvg(); await unlink(path); await writeFile(path, bytes); },
      async (path: string) => { await unlink(path); await symlink("replacement.svg", path); await writeFile(join(path, "..", "replacement.svg"), canonicalSvg()); },
    ]) {
      const value = await fixture(); const path = join(value.source, "icons", "asset.svg");
      const plan = await planImport({ source: { kind: "directory", path: value.source }, root: value.root, collections: ["icons"] });
      await replace(path);
      await expect(executeImport(plan)).rejects.toMatchObject({ diagnostic: { code: "DIRECTORY_SOURCE_CHANGED" } });
      await absent(value.root);
    }
  });

  it("rejects persistent source-root and target-root retargeting", async () => {
    const sourceRace = await fixture(); const attacker = join(sourceRace.base, "attacker");
    await mkdir(join(attacker, "icons"), { recursive: true }); await writeFile(join(attacker, "icons", "asset.svg"), canonicalSvg()); await writeFile(join(attacker, ".tfsb-source-map.toml"), map());
    const sourcePlan = await planImport({ source: { kind: "directory", path: sourceRace.source }, root: sourceRace.root, collections: ["icons"] });
    await rename(sourceRace.source, join(sourceRace.base, "original-source")); await rename(attacker, sourceRace.source);
    await expect(executeImport(sourcePlan)).rejects.toMatchObject({ diagnostic: { code: "DIRECTORY_SOURCE_CHANGED" } }); await absent(sourceRace.root);

    const targetRace = await fixture(); const targetPlan = await planImport({ source: { kind: "directory", path: targetRace.source }, root: targetRace.root, collections: ["icons"] });
    await rename(targetRace.root, join(targetRace.base, "original-target")); await mkdir(targetRace.root);
    await expect(executeImport(targetPlan)).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } }); await absent(targetRace.root);
  });

  it("rejects selected-view insertion and deletion", async () => {
    const inserted = await fixture(); const insertPlan = await planImport({ source: { kind: "directory", path: inserted.source }, root: inserted.root, collections: ["icons"] });
    await writeFile(join(inserted.source, "icons", "new.svg"), canonicalSvg());
    await expect(executeImport(insertPlan)).rejects.toMatchObject({ diagnostic: { code: "DIRECTORY_SOURCE_CHANGED" } }); await absent(inserted.root);

    const deleted = await fixture(); const deletePlan = await planImport({ source: { kind: "directory", path: deleted.source }, root: deleted.root, collections: ["icons"] });
    await unlink(join(deleted.source, "icons", "asset.svg"));
    await expect(executeImport(deletePlan)).rejects.toMatchObject({ diagnostic: { code: "DIRECTORY_SOURCE_CHANGED" } }); await absent(deleted.root);
  });

  it("rejects companion identity/byte drift", async () => {
    const value = await fixture(true);
    const plan = await planImport({ source: { kind: "directory", path: value.source }, root: value.root, collections: ["icons"], companions: ["icons/README.md"] });
    await writeFile(join(value.source, "icons", "README.md"), "changed\n");
    await expect(executeImport(plan)).rejects.toMatchObject({ diagnostic: { code: "DIRECTORY_SOURCE_CHANGED" } }); await absent(value.root);
  });

  it("accepts semantic-equivalent source-map formatting and rejects semantic change", async () => {
    const formatting = await fixture(); const formattingPlan = await planImport({ source: { kind: "directory", path: formatting.source }, root: formatting.root, collections: ["icons"] });
    await writeFile(join(formatting.source, ".tfsb-source-map.toml"), `# formatting\n${map()}`);
    await executeImport(formattingPlan); await access(join(formatting.root, ".tfsb"));

    const semantic = await fixture(); const semanticPlan = await planImport({ source: { kind: "directory", path: semantic.source }, root: semantic.root, collections: ["icons"] });
    await writeFile(join(semantic.source, ".tfsb-source-map.toml"), map("changed-"));
    await expect(executeImport(semanticPlan)).rejects.toMatchObject({ diagnostic: { code: "SOURCE_MAP_CHANGED" } }); await absent(semantic.root);
  });

  it("binds normalization-map file identity and bytes, including formatting-only rewrites", async () => {
    for (const replacement of ['schema_version = 1\n[defaults]\nunlabelled_mode = "consumer_labelled"\n', '# formatting\nschema_version = 1\n[defaults]\nunlabelled_mode = "decorative"\n']) {
      const value = await fixture(); const normalizationMap = join(value.base, "normalization.toml");
      await writeFile(normalizationMap, 'schema_version = 1\n[defaults]\nunlabelled_mode = "decorative"\n');
      const plan = await planImport({ source: { kind: "directory", path: value.source }, root: value.root, collections: ["icons"], normalize: "exact-common", normalizationMap });
      await writeFile(normalizationMap, replacement);
      await expect(executeImport(plan)).rejects.toMatchObject({ diagnostic: { code: "NORMALIZATION_MAP_CHANGED" } }); await absent(value.root);
    }
  });
});
