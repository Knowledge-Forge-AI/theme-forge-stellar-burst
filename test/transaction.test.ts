import { access, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { executeImport, importProject, planImport, planImportWithHooks } from "../src/importer.js";
import { findProjectRoot } from "../src/root.js";
import { executeCanonicalTransaction, snapshotCanonicalTree } from "../src/transaction.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function initialized() {
  const root = await mkdtemp(join(tmpdir(), "tfsb-transaction-"));
  roots.push(root);
  const svg = await readFile(join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1/favicon.svg"));
  const archive = join(root, "source.zip");
  await writeFile(archive, zipSync({ "favicon.svg": svg }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
  await importProject({ archive, root });
  const snapshot = await snapshotCanonicalTree(root);
  const next = new Map([...snapshot.files].map(([path, file]) => [path, file.bytes]));
  const assetPath = ".tfsb/assets/favicon.toml";
  next.set(assetPath, Buffer.concat([Buffer.from(next.get(assetPath)!), Buffer.from("# next\n")]));
  return { root, snapshot, next, assetPath };
}

async function residue(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith(".tfsb-stage-") || name.startsWith(".tfsb-backup-") || name === ".tfsb.lock");
}

function initialTree(label = "concurrent"): Map<string, Uint8Array> {
  return new Map([
    [".tfsb/project.toml", Buffer.from(`schema_version = 1\nname = "${label}"\n\n[build]\ndirectory = "dist"\n`)],
    [".tfsb/assets/x.toml", Buffer.from(`${label}\n`)],
  ]);
}

async function materializeCanonical(root: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  await mkdir(join(root, ".tfsb/assets"), { recursive: true });
  for (const [relative, bytes] of files) {
    await writeFile(join(root, relative), bytes);
  }
}

describe("recoverable canonical-tree transaction", () => {
  it("fails closed on lock contention without staging", async () => {
    const value = await initialized();
    const lock = await open(join(value.root, ".tfsb.lock"), "wx", 0o600);
    await lock.close();
    await expect(executeCanonicalTransaction({ root: value.root, nextFiles: value.next, expectedSnapshot: value.snapshot }))
      .rejects.toMatchObject({ diagnostic: { code: "ROOT_LOCKED" } });
    expect(await residue(value.root)).toEqual([".tfsb.lock"]);
  });

  it("detects a changed canonical snapshot before the first rename", async () => {
    const value = await initialized();
    const path = join(value.root, value.assetPath);
    await expect(executeCanonicalTransaction({
      root: value.root, nextFiles: value.next, expectedSnapshot: value.snapshot,
      hooks: { afterStageWrite: async () => writeFile(path, `${await readFile(path, "utf8")}# concurrent\n`) },
    })).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
    expect(await readFile(path, "utf8")).toContain("# concurrent");
    expect(await residue(value.root)).toEqual([]);
  });

  it.each([
    ["stage creation", { beforeStageCreate: () => { throw new Error("injected"); } }],
    ["stage write", { beforeStageWrite: () => { throw new Error("injected"); } }],
    ["first rename", { beforeFirstRename: () => { throw new Error("injected"); } }],
    ["promotion with successful rollback", { beforePromotion: () => { throw new Error("injected"); } }],
  ])("preserves the old complete tree after %s failure", async (_name, hooks) => {
    const value = await initialized();
    const before = await readFile(join(value.root, value.assetPath));
    await expect(executeCanonicalTransaction({ root: value.root, nextFiles: value.next, expectedSnapshot: value.snapshot, hooks }))
      .rejects.toMatchObject({ diagnostic: { code: "TFSB_TRANSACTION_FAILED" } });
    expect(await readFile(join(value.root, value.assetPath))).toEqual(before);
    expect(await residue(value.root)).toEqual([]);
  });

  it("leaves explicit backup residue when rollback fails", async () => {
    const value = await initialized();
    await expect(executeCanonicalTransaction({
      root: value.root, nextFiles: value.next, expectedSnapshot: value.snapshot,
      hooks: {
        beforePromotion: () => { throw new Error("promotion"); },
        beforeRollback: () => { throw new Error("rollback"); },
      },
    })).rejects.toMatchObject({ diagnostic: { code: "TFSB_ROLLBACK_FAILED" } });
    expect((await residue(value.root)).some((name) => name.startsWith(".tfsb-backup-"))).toBe(true);
    await expect(findProjectRoot(value.root, "reconcile", true))
      .rejects.toMatchObject({ diagnostic: { code: "TFSB_RECOVERY_REQUIRED" } });
  });

  it("reports backup cleanup failure while keeping the new tree active", async () => {
    const value = await initialized();
    await expect(executeCanonicalTransaction({
      root: value.root, nextFiles: value.next, expectedSnapshot: value.snapshot,
      hooks: { beforeBackupCleanup: () => { throw new Error("cleanup"); } },
    })).rejects.toMatchObject({ diagnostic: { code: "TFSB_BACKUP_CLEANUP_FAILED" } });
    expect(await readFile(join(value.root, value.assetPath), "utf8")).toContain("# next");
    expect((await residue(value.root)).some((name) => name.startsWith(".tfsb-backup-"))).toBe(true);
    expect(await findProjectRoot(value.root, "reconcile", true)).toBe(await realpath(value.root));
  });

  it.each([".tfsb-stage-orphan", ".tfsb-backup-orphan"])("detects %s residue when the project marker is absent", async (orphan) => {
    const value = await initialized();
    await rename(join(value.root, ".tfsb"), join(value.root, orphan));
    await expect(findProjectRoot(value.root, "check", true))
      .rejects.toMatchObject({ diagnostic: { code: "TFSB_RECOVERY_REQUIRED" } });
  });

  it("leaves no canonical tree after a failed initial promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-initial-transaction-"));
    roots.push(root);
    const snapshot = await snapshotCanonicalTree(root, true);
    const next = new Map<string, Uint8Array>([
      [".tfsb/project.toml", Buffer.from('schema_version = 1\nname = "x"\n\n[build]\ndirectory = "dist"\n')],
      [".tfsb/assets/x.toml", Buffer.from("placeholder")],
    ]);
    await expect(executeCanonicalTransaction({
      root, nextFiles: next, expectedSnapshot: snapshot,
      hooks: { beforePromotion: () => { throw new Error("injected"); } },
    })).rejects.toMatchObject({ diagnostic: { code: "TFSB_TRANSACTION_FAILED" } });
    await expect(access(join(root, ".tfsb"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await residue(root)).toEqual([]);
  });

  it("captures authoritative expected absence immediately after import root validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-import-snapshot-"));
    roots.push(root);
    const svg = await readFile(join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1/favicon.svg"));
    const archive = join(root, "source.zip");
    await writeFile(archive, zipSync({ "favicon.svg": svg }, { level: 0 }));
    const concurrent = initialTree("snapshot-winner");

    await expect(planImportWithHooks(
      { archive, root, recordProvenance: true },
      { afterRootValidation: () => materializeCanonical(root, concurrent) },
    )).rejects.toMatchObject({ diagnostic: { code: "ROOT_ALREADY_INITIALIZED" } });

    const captured = await snapshotCanonicalTree(root);
    expect(new Map([...captured.files].map(([path, file]) => [path, Buffer.from(file.bytes)])))
      .toEqual(new Map([...concurrent].map(([path, bytes]) => [path, Buffer.from(bytes)])));
    expect(await residue(root)).toEqual([]);
  });

  it.each(["beforeStageCreate", "beforeStageWrite", "afterStageWrite", "beforePromotion"] as const)(
    "never replaces a canonical project created at the %s import seam",
    async (seam) => {
      const root = await mkdtemp(join(tmpdir(), "tfsb-concurrent-import-"));
      roots.push(root);
      const svg = await readFile(join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1/favicon.svg"));
      const archive = join(root, "source.zip");
      await writeFile(archive, zipSync({ "favicon.svg": svg }, { level: 0 }));
      const plan = await planImport({ archive, root, recordProvenance: true });
      const concurrent = initialTree(seam);

      await expect(executeImport(plan, { [seam]: () => materializeCanonical(root, concurrent) }))
        .rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });

      const captured = await snapshotCanonicalTree(root);
      expect(new Map([...captured.files].map(([path, file]) => [path, Buffer.from(file.bytes)])))
        .toEqual(new Map([...concurrent].map(([path, bytes]) => [path, Buffer.from(bytes)])));
      expect(await residue(root)).toEqual([]);
    },
  );

  it("preserves a canonical project created during provenance archive inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-import-archive-race-"));
    roots.push(root);
    const svg = await readFile(join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1/favicon.svg"));
    const archive = join(root, "source.zip");
    await writeFile(archive, zipSync({ "favicon.svg": svg }, { level: 0 }));
    const concurrent = initialTree("archive-winner");
    const plan = await planImportWithHooks(
      { archive, root, recordProvenance: true },
      { archiveHooks: { afterStructure: () => materializeCanonical(root, concurrent) } },
    );

    await expect(executeImport(plan))
      .rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
    const captured = await snapshotCanonicalTree(root);
    expect(new Map([...captured.files].map(([path, file]) => [path, Buffer.from(file.bytes)])))
      .toEqual(new Map([...concurrent].map(([path, bytes]) => [path, Buffer.from(bytes)])));
    expect(await residue(root)).toEqual([]);
  });

  it("reports an active initial tree without claiming a nonexistent retained backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-initial-durability-"));
    roots.push(root);
    const snapshot = await snapshotCanonicalTree(root, true, "import");
    let error: unknown;
    try {
      await executeCanonicalTransaction({
        root,
        nextFiles: initialTree("initial-active"),
        expectedSnapshot: snapshot,
        operation: "import",
        hooks: { beforePromotionParentSync: () => { throw new Error("injected fsync failure"); } },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ diagnostic: { code: "TFSB_PROMOTION_DURABILITY_FAILED" } });
    expect((error as Error).message).toContain("no prior backup was created");
    expect((error as Error).message).not.toContain("retained backup");
    await access(join(root, ".tfsb/project.toml"));
    expect(await residue(root)).toEqual([]);
  });

  it("reports a retained backup after replacement promotion durability failure", async () => {
    const value = await initialized();
    let error: unknown;
    try {
      await executeCanonicalTransaction({
        root: value.root,
        nextFiles: value.next,
        expectedSnapshot: value.snapshot,
        hooks: { beforePromotionParentSync: () => { throw new Error("injected fsync failure"); } },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ diagnostic: { code: "TFSB_PROMOTION_DURABILITY_FAILED" } });
    expect((error as Error).message).toContain("was retained for inspection");
    expect((await residue(value.root)).some((name) => name.startsWith(".tfsb-backup-"))).toBe(true);
  });

  it("leaves no .tfsb when provenance import evidence changes before commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-provenance-import-"));
    roots.push(root);
    const svg = await readFile(join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1/favicon.svg"));
    const archive = join(root, "source.zip");
    await writeFile(archive, zipSync({ "favicon.svg": svg }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    const plan = await planImport({ archive, root, recordProvenance: true });
    await writeFile(archive, zipSync({ "favicon.svg": Buffer.concat([svg, Buffer.from(" ")]) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    await expect(executeImport(plan)).rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_CHANGED_DURING_PLAN" } });
    await expect(access(join(root, ".tfsb"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await residue(root)).toEqual([]);
  });
});
