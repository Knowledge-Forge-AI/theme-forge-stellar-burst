import { access, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildProject,
  BUILD_RECEIPT_FILENAME,
  checkProject,
  diffProject,
  executeMigration,
  formatProject,
  importProject,
  installProject,
  listProject,
  loadCanonicalProject,
  migrateProject,
  parseImportProvenanceV2,
  planMigration,
  planBundle,
  planPreview,
  reconcileProject,
  type ImportProvenanceV2,
  type AssetProvenanceRecordV2,
} from "../src/index.js";
import { runCli } from "../src/cli.js";
import { makeTempDir, unwrap } from "./helpers.js";

const FIXTURE = join(process.cwd(), "test/fixtures/tftn-production-v1");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function initialized(state: "absent" | "partial" | "complete", minimal = false): Promise<string> {
  const root = makeTempDir(`tfsb-migrate-${state}-`); roots.push(root);
  await mkdir(join(root, "brand"), { recursive: true });
  const names = minimal ? ["mark-monochrome-dark.svg"] : (await readdir(FIXTURE)).filter((name) => name.endsWith(".svg") || name === "README.md");
  const entries = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(join(FIXTURE, name))])));
  const archive = join(root, "source.zip");
  await writeFile(archive, zipSync(entries, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
  await importProject({ archive, root, schema: 1, ...(minimal ? {} : { companions: ["README.md"] }), recordProvenance: state !== "absent" });
  if (state === "partial") {
    const path = join(root, ".tfsb", "provenance.json");
    const provenance = JSON.parse(await readFile(path, "utf8")) as { records: { type: string }[] };
    provenance.records = provenance.records.filter((record, index) => record.type === "companion" || index % 2 === 0);
    await writeFile(path, `${JSON.stringify(provenance, null, 2)}\n`);
  }
  return root;
}

describe("whole-project schema migration", () => {
  it.each(["absent", "partial", "complete"] as const)("migrates Terminal Nova with %s provenance truthfully and byte-identically", async (state) => {
    const root = await initialized(state);
    const before = await loadCanonicalProject(root, "migrate");
    const beforeOutputs = new Map(before.outputs);
    const companion = before.companions.get("README.md");
    await buildProject(root, false);
    const receiptPath = join(root, before.project.buildDirectory, BUILD_RECEIPT_FILENAME);
    const receiptBefore = await readFile(receiptPath);

    const check = await planMigration({ root, check: true });
    expect(check).toMatchObject({ mode: "check", fromSchemaVersion: 1, toSchemaVersion: 2, assetCount: 10, companionCount: 1, svgEquivalentCount: 10, migrationNeeded: true, applied: false, buildReceiptSourceStale: true });
    expect(check.files).toHaveLength(10);
    expect((await loadCanonicalProject(root, "migrate")).project.schemaVersion).toBe(1);

    const result = await migrateProject({ root });
    expect(result.applied).toBe(true);
    const after = await loadCanonicalProject(root, "migrate");
    expect(after.project.schemaVersion).toBe(2);
    expect(after.companions.get("README.md")).toEqual(companion);
    for (const [filename, bytes] of beforeOutputs) expect(after.outputs.get(filename)).toEqual(bytes);
    expect(await readFile(receiptPath)).toEqual(receiptBefore);
    expect((await checkProject(root)).sourceChanged).toBe(true);

    const provenance = unwrap(parseImportProvenanceV2(await readFile(join(root, ".tfsb", "provenance.json"), "utf8"))) as ImportProvenanceV2;
    const assets = provenance.records.filter((record): record is AssetProvenanceRecordV2 => record.type === "asset" && record.migration !== null);
    expect(assets).toHaveLength(10);
    expect(assets.every((record) => record.migration?.beforeSvgDigest === record.migration?.afterSvgDigest)).toBe(true);
    const archived = assets.filter((record) => record.archive !== null).length;
    expect(archived).toBe(state === "absent" ? 0 : state === "complete" ? 10 : 5);
    expect(await formatProject({ root, check: true })).toMatchObject({ changed: false, applied: false });
    expect((await listProject(root)).assets).toHaveLength(10);
    const provenanceDiff = await diffProject({ root, baseline: "provenance" });
    expect(provenanceDiff).toMatchObject({ baseline: "provenance", different: state === "absent" });
    if (state === "absent" && provenanceDiff.baseline === "provenance") expect(provenanceDiff.records).toContainEqual(expect.objectContaining({ key: "companion:README.md", relation: "untracked_current_record" }));
    const archiveDiff = await diffProject({ root, baseline: "archive", archive: join(root, "source.zip") });
    expect(archiveDiff).toMatchObject({ baseline: "archive", different: state === "absent", changes: [] });
    const reconciliation = await reconcileProject({ root, archive: join(root, "source.zip"), companions: ["README.md"] });
    expect(reconciliation).toMatchObject({ blocked: false, applied: false });
    expect(reconciliation.records.filter((record) => record.kind === "asset").every((record) => record.classification === "UNCHANGED_ACCEPTED_DIVERGENCE")).toBe(true);
    expect((await planBundle({ root, output: `terminal-nova-${state}.zip` })).entries.filter((entry) => entry.type === "asset")).toHaveLength(10);
    expect((await planPreview({ root })).assets).toHaveLength(10);
    await buildProject(root, false); await installProject(root);
    expect(await checkProject(root)).toMatchObject({ sourceChanged: false, build: { missing: [], different: [] }, install: { missing: [], different: [] } });
    expect(await planMigration({ root, check: true })).toMatchObject({ migrationNeeded: false, fromSchemaVersion: 2, applied: false });
  });

  it("treats a changed Terminal Nova archive as fresh schema-1 source against migrated schema 2", async () => {
    const root = await initialized("complete"); await migrateProject({ root });
    const names = (await readdir(FIXTURE)).filter((name) => name.endsWith(".svg") || name === "README.md");
    const entries = Object.fromEntries(await Promise.all(names.map(async (name) => {
      const bytes = await readFile(join(FIXTURE, name));
      return [name, name === "mark-monochrome-dark.svg" ? Buffer.from(Buffer.from(bytes).toString("utf8").replace("#111318", "#111319")) : bytes];
    })));
    const changed = join(root, "changed.zip"); await writeFile(changed, zipSync(entries, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    const result = await reconcileProject({ root, archive: changed, companions: ["README.md"] });
    expect(result).toMatchObject({ blocked: false, applied: false });
    expect(result.records).toContainEqual(expect.objectContaining({ classification: "ARCHIVE_CHANGED", blocker: false }));
  });

  it("rejects a stale or forged public migration plan", async () => {
    const root = await initialized("absent", true);
    const plan = await planMigration({ root });
    await expect(executeMigration({ ...plan })).rejects.toMatchObject({ diagnostic: { code: "TRANSACTION_INVALID_PLAN" } });
    expect((await loadCanonicalProject(root, "migrate")).project.schemaVersion).toBe(1);
  });

  it("emits released migration JSON and bounded human output without private paths or source text", async () => {
    const root = await initialized("absent");
    let stdout = ""; let stderr = "";
    const exit = await runCli(["migrate", "--root", root, "--check", "--json"], root, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
    expect(exit).toBe(2); expect(stderr).toBe("");
    const envelope = JSON.parse(stdout) as { command: string; status: string; exitCode: number; data: { mode: string; root?: string; files: unknown[] } };
    expect(envelope).toMatchObject({ command: "migrate", status: "drift", exitCode: 2, data: { mode: "check" } });
    expect(envelope.data.root).toBeUndefined(); expect(envelope.data.files).toHaveLength(10); expect(stdout).not.toContain(root);
    stdout = "";
    expect(await runCli(["migrate", "--root", root, "--check"], root, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } })).toBe(2);
    expect(stdout).toContain("Migration required: schema 1 -> 2"); expect(stdout).not.toContain(root);
  });

  it.each([
    ["stage creation", { beforeStageCreate: () => { throw new Error("injected"); } }],
    ["stage write", { beforeStageWrite: () => { throw new Error("injected"); } }],
    ["first rename", { beforeFirstRename: () => { throw new Error("injected"); } }],
    ["promotion with rollback", { beforePromotion: () => { throw new Error("injected"); } }],
  ] as const)("keeps the complete schema-1 tree after %s failure", async (_label, hooks) => {
    const root = await initialized("absent", true); const before = await readFile(join(root, ".tfsb/project.toml")); const plan = await planMigration({ root });
    await expect(executeMigration(plan, hooks)).rejects.toMatchObject({ diagnostic: { code: "TFSB_TRANSACTION_FAILED" } });
    expect(await readFile(join(root, ".tfsb/project.toml"))).toEqual(before);
    expect((await readdir(root)).filter((name) => name.startsWith(".tfsb-stage-") || name.startsWith(".tfsb-backup-") || name === ".tfsb.lock")).toEqual([]);
  });

  it("rejects staged corruption and a changed canonical snapshot before promotion", async () => {
    const root = await initialized("absent", true); const plan = await planMigration({ root }); const first = plan.files[0]!.path.slice(".tfsb/assets/".length);
    await expect(executeMigration(plan, { afterStageWrite: async () => {
      const stage = (await readdir(root)).find((name) => name.startsWith(".tfsb-stage-"))!;
      await writeFile(join(root, stage, "assets", first), "invalid");
    } })).rejects.toBeDefined();
    expect((await loadCanonicalProject(root, "migrate")).project.schemaVersion).toBe(1);

    const second = await planMigration({ root }); await writeFile(join(root, ".tfsb/project.toml"), `${await readFile(join(root, ".tfsb/project.toml"), "utf8")}# concurrent\n`);
    await expect(executeMigration(second)).rejects.toMatchObject({ diagnostic: { code: "CANONICAL_CHANGED_DURING_PLAN" } });
    expect((await loadCanonicalProject(root, "migrate")).project.schemaVersion).toBe(1);
  });

  it("reports lock contention, rollback residue, and active-new backup cleanup failure accurately", async () => {
    const lockedRoot = await initialized("absent", true); const lockedPlan = await planMigration({ root: lockedRoot }); const lock = await open(join(lockedRoot, ".tfsb.lock"), "wx", 0o600); await lock.close();
    await expect(executeMigration(lockedPlan)).rejects.toMatchObject({ diagnostic: { code: "ROOT_LOCKED" } }); await rm(join(lockedRoot, ".tfsb.lock"));

    const rollbackRoot = await initialized("absent", true); const rollbackPlan = await planMigration({ root: rollbackRoot });
    await expect(executeMigration(rollbackPlan, { beforePromotion: () => { throw new Error("promotion"); }, beforeRollback: () => { throw new Error("rollback"); } })).rejects.toMatchObject({ diagnostic: { code: "TFSB_ROLLBACK_FAILED" } });
    expect((await readdir(rollbackRoot)).some((name) => name.startsWith(".tfsb-backup-"))).toBe(true);
    await expect(access(join(rollbackRoot, ".tfsb"))).rejects.toMatchObject({ code: "ENOENT" });

    const cleanupRoot = await initialized("absent", true); const cleanupPlan = await planMigration({ root: cleanupRoot });
    await expect(executeMigration(cleanupPlan, { beforeBackupCleanup: () => { throw new Error("cleanup"); } })).rejects.toMatchObject({ diagnostic: { code: "TFSB_BACKUP_CLEANUP_FAILED" } });
    expect((await loadCanonicalProject(cleanupRoot, "migrate")).project.schemaVersion).toBe(2);
    expect((await readdir(cleanupRoot)).some((name) => name.startsWith(".tfsb-backup-"))).toBe(true);
  });

  it("refuses to execute a check-mode migration plan", async () => {
    const root = await initialized("absent", true);
    const checkPlan = await planMigration({ root, check: true });
    await expect(executeMigration(checkPlan)).rejects.toMatchObject({ diagnostic: { code: "TRANSACTION_INVALID_PLAN" } });
  });
});
