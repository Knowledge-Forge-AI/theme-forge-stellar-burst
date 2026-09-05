import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeAssetEdit, planAssetEdit, type AssetEditPlan } from "../src/edit.js";

const roots: string[] = [];

const PROJECT = `schema_version = 1
name = "Asset edit fixture"

[build]
directory = "dist"
`;

const ALPHA = `schema_version = 1
id = "alpha"
filename = "alpha.svg"

[canvas]
view_box = "0 0 10 10"

[accessibility]
title = "Alpha"
title_id = "alpha-title"
description = "Alpha icon"
description_id = "alpha-description"

[[elements]]
type = "path"
d = "M0 0 L10 10"
`;

const BETA = ALPHA.replaceAll("alpha", "beta").replaceAll("Alpha", "Beta");
const PROVENANCE = Buffer.from('{"fixture":"preserve-me"}\n', "utf8");
const COMPANION = Buffer.from("companion bytes must remain unchanged\n", "utf8");

async function fixture(): Promise<{ readonly root: string; readonly before: ReadonlyMap<string, Buffer> }> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-edit-"));
  roots.push(root);
  await mkdir(join(root, ".tfsb", "assets"), { recursive: true });
  await mkdir(join(root, ".tfsb", "companions"), { recursive: true });
  await writeFile(join(root, ".tfsb", "project.toml"), PROJECT);
  await writeFile(join(root, ".tfsb", "assets", "alpha.toml"), ALPHA);
  await writeFile(join(root, ".tfsb", "assets", "beta.toml"), BETA);
  await writeFile(join(root, ".tfsb", "companions", "README.md"), COMPANION);
  await writeFile(join(root, ".tfsb", "provenance.json"), PROVENANCE);
  const before = new Map<string, Buffer>();
  for (const relative of [
    ".tfsb/project.toml",
    ".tfsb/assets/alpha.toml",
    ".tfsb/assets/beta.toml",
    ".tfsb/companions/README.md",
    ".tfsb/provenance.json",
  ]) before.set(relative, await readFile(join(root, relative)));
  return { root, before };
}

function proposal(title: string, filename = "alpha.svg", id = "alpha"): string {
  return ALPHA
    .replace('id = "alpha"', `id = "${id}"`)
    .replace('filename = "alpha.svg"', `filename = "${filename}"`)
    .replace('title = "Alpha"', `title = "${title}"`)
    .replace('description = "Alpha icon"', `description = "${title} icon"`);
}

async function residue(root: string): Promise<readonly string[]> {
  return (await readdir(root)).filter((name) => name === ".tfsb.lock" || name.startsWith(".tfsb-stage-") || name.startsWith(".tfsb-backup-"));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical asset edit seam", () => {
  it("plans and executes a direct edit while preserving the complete canonical tree", async () => {
    const value = await fixture();
    const plan = await planAssetEdit({ root: value.root, assetId: "alpha", proposedToml: proposal("Edited alpha", "renamed.svg") });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan).toMatchObject({
      assetId: "alpha",
      affectedCanonicalPath: ".tfsb/assets/alpha.toml",
      changed: true,
    });
    expect(plan.oldDigest).not.toBe(plan.newDigest);
    expect(plan.semanticChanges.length).toBeGreaterThan(0);

    await executeAssetEdit(plan);

    expect(await readFile(join(value.root, ".tfsb/assets/alpha.toml"), "utf8")).toMatch(/filename = "renamed\.svg"[\s\S]*title = "Edited alpha"/);
    for (const [relative, bytes] of value.before) {
      if (relative !== ".tfsb/assets/alpha.toml") expect(await readFile(join(value.root, relative))).toEqual(bytes);
    }
    await expect(access(join(value.root, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(value.root, ".tfsb-preview"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await residue(value.root)).toEqual([]);
  });

  it("applies canonical byte changes even when normalized asset semantics are unchanged", async () => {
    const value = await fixture();
    await writeFile(join(value.root, ".tfsb/assets/alpha.toml"), `# noncanonical input\n${ALPHA}`);
    const plan = await planAssetEdit({ root: value.root, assetId: "alpha", proposedToml: ALPHA });

    expect(plan.oldDigest).toBe(plan.newDigest);
    expect(plan.semanticChanges).toEqual([]);
    expect(plan.changed).toBe(true);
    await executeAssetEdit(plan);
    expect(await readFile(join(value.root, ".tfsb/assets/alpha.toml"), "utf8")).not.toContain("noncanonical input");
    expect(await residue(value.root)).toEqual([]);
  });

  it.each([
    ["unknown asset", "gamma", () => proposal("Edited", "gamma.svg", "gamma"), "PROJECT_UNKNOWN_ASSET", "gamma"],
    ["ID mismatch", "alpha", () => proposal("Edited", "alpha.svg", "beta"), "PROJECT_ASSET_FILENAME_MISMATCH", "id"],
    ["schema mismatch", "alpha", () => proposal("Edited").replace("schema_version = 1", "schema_version = 2"), "SCHEMA_PROJECT_VERSION_MISMATCH", "schema_version"],
    ["filename collision", "alpha", () => proposal("Edited", "beta.svg"), "PROJECT_DUPLICATE_FILENAME", "filename"],
  ] as const)("rejects %s", async (_name, assetId, makeProposal, code, _location) => {
    const value = await fixture();
    await expect(planAssetEdit({ root: value.root, assetId, proposedToml: makeProposal() }))
      .rejects.toMatchObject({ diagnostic: { code } });
    expect(await readFile(join(value.root, ".tfsb/assets/alpha.toml"))).toEqual(value.before.get(".tfsb/assets/alpha.toml"));
  });

  it("requires the authentic WeakMap-backed plan and rejects copied plans", async () => {
    const value = await fixture();
    const plan = await planAssetEdit({ root: value.root, assetId: "alpha", proposedToml: proposal("Edited alpha") });
    const copied = { ...plan } as AssetEditPlan;
    const frozenCopy = Object.freeze({ ...plan }) as AssetEditPlan;

    await expect(executeAssetEdit(copied)).rejects.toMatchObject({ diagnostic: { code: "TRANSACTION_INVALID_PLAN" } });
    await expect(executeAssetEdit(frozenCopy)).rejects.toMatchObject({ diagnostic: { code: "TRANSACTION_INVALID_PLAN" } });
    expect(await readFile(join(value.root, ".tfsb/assets/alpha.toml"))).toEqual(value.before.get(".tfsb/assets/alpha.toml"));
    expect(await residue(value.root)).toEqual([]);
  });

  it("rejects canonical drift using the complete captured snapshot", async () => {
    const value = await fixture();
    const plan = await planAssetEdit({ root: value.root, assetId: "alpha", proposedToml: proposal("Edited alpha") });
    await writeFile(join(value.root, ".tfsb", "project.toml"), `${PROJECT}# drift\n`);

    await expect(executeAssetEdit(plan)).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
    expect(await readFile(join(value.root, ".tfsb/assets/alpha.toml"))).toEqual(value.before.get(".tfsb/assets/alpha.toml"));
    expect(await residue(value.root)).toEqual([]);
  });

  it("rejects canonical drift introduced after staging", async () => {
    const value = await fixture();
    const plan = await planAssetEdit({ root: value.root, assetId: "alpha", proposedToml: proposal("Edited alpha") });

    await expect(executeAssetEdit(plan, {
      afterStageWrite: async () => {
        await writeFile(join(value.root, ".tfsb", "companions", "README.md"), "concurrent canonical bytes\n");
      },
    })).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
    expect(await readFile(join(value.root, ".tfsb/assets/alpha.toml"))).toEqual(value.before.get(".tfsb/assets/alpha.toml"));
    expect(await residue(value.root)).toEqual([]);
  });

  it("rejects canonical drift at the last pre-rename hook", async () => {
    const value = await fixture();
    const plan = await planAssetEdit({ root: value.root, assetId: "alpha", proposedToml: proposal("Edited alpha") });

    await expect(executeAssetEdit(plan, {
      beforeFirstRename: async () => {
        await writeFile(join(value.root, ".tfsb", "provenance.json"), "concurrent provenance bytes\n");
      },
    })).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
    expect(await readFile(join(value.root, ".tfsb/assets/alpha.toml"))).toEqual(value.before.get(".tfsb/assets/alpha.toml"));
    expect(await residue(value.root)).toEqual([]);
  });

  it("validates staged bytes and cleans up after staged corruption", async () => {
    const value = await fixture();
    const plan = await planAssetEdit({ root: value.root, assetId: "alpha", proposedToml: proposal("Edited alpha") });

    await expect(executeAssetEdit(plan, {
      afterStageWrite: async () => {
        const stage = (await readdir(value.root)).find((name) => name.startsWith(".tfsb-stage-"));
        expect(stage).toBeDefined();
        await writeFile(join(value.root, stage!, "assets", "alpha.toml"), "corrupted staged bytes\n");
      },
    })).rejects.toMatchObject({ diagnostic: { code: "EDIT_STAGE_INVALID" } });
    expect(await readFile(join(value.root, ".tfsb/assets/alpha.toml"))).toEqual(value.before.get(".tfsb/assets/alpha.toml"));
    expect(await residue(value.root)).toEqual([]);
  });

  it("rolls back and cleans up when promotion fails", async () => {
    const value = await fixture();
    const plan = await planAssetEdit({ root: value.root, assetId: "alpha", proposedToml: proposal("Edited alpha") });

    await expect(executeAssetEdit(plan, { beforePromotion: () => { throw new Error("injected promotion failure"); } }))
      .rejects.toMatchObject({ diagnostic: { code: "TFSB_TRANSACTION_FAILED" } });
    expect(await readFile(join(value.root, ".tfsb/assets/alpha.toml"))).toEqual(value.before.get(".tfsb/assets/alpha.toml"));
    expect(await residue(value.root)).toEqual([]);
  });
});
