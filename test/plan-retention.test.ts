import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildProject, executeBuild, inspectBuildPlanRetention, planBuild, planBuildWithHooks } from "../src/build.js";
import { inspectPlanRetention, mergePlanRetention } from "../src/plan-retention.js";
import {
  executeAuthenticImport,
  executeImport,
  importProject,
  planImport,
  type ImportPlan,
} from "../src/importer.js";
import { executePreviewPlan, planPreview, previewProject } from "../src/preview.js";
import { executeReconciliationPlan, planReconciliation } from "../src/reconcile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function archiveAt(root: string, svg: Uint8Array): Promise<string> {
  const archive = join(root, "source.zip");
  await writeFile(archive, zipSync({ "favicon.svg": svg }, { level: 0 }));
  return archive;
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfsb-plan-retention-"));
  roots.push(root);
  return root;
}

describe("TFSB45B1 domain seams", () => {
  it("counts retained byte-array instances and repeated UTF-8 string occurrences", () => {
    const bytes = new Uint8Array([1, 2]);
    const inspection = inspectPlanRetention([
      { first: bytes, second: bytes, text: "é" },
      { text: "é", bytes: Buffer.from([3, 4, 5]) },
    ], "directory");
    expect(inspection.byteArrays).toHaveLength(2);
    expect(inspection.byteArrayBytes).toBe(5);
    expect(inspection.stringByteLengths).toEqual([2, 2]);
    expect(inspection.stringBytes).toBe(4);
    expect(inspection.nativeSnapshot).toBe("directory");
    expect(mergePlanRetention(inspection, inspectPlanRetention([bytes])).byteArrays).toHaveLength(2);
  });

  it("honors bounded planner cancellation before producing a plan", async () => {
    const root = await freshRoot();
    await expect(planBuildWithHooks(root, { checkCancelled: () => { throw new Error("cancelled"); } })).rejects.toThrow("cancelled");
  });

  it("rejects copied authentic imports while preserving legacy executeImport", async () => {
    const root = await freshRoot();
    const svg = await readFile(join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1/favicon.svg"));
    const archive = await archiveAt(root, svg);
    const plan = await planImport({ archive, root, schema: 1, recordProvenance: true });
    await expect(executeAuthenticImport({ ...plan } as ImportPlan)).rejects.toMatchObject({ diagnostic: { code: "IMPORT_INVALID_PLAN" } });

    const legacyRoot = await freshRoot();
    const legacyArchive = await archiveAt(legacyRoot, svg);
    const legacyPlan = await planImport({ archive: legacyArchive, root: legacyRoot, schema: 1 });
    await executeImport(legacyPlan);
    await access(join(legacyRoot, ".tfsb/project.toml"));
  });

  it("passes reconciliation transaction hooks without changing its planner contract", async () => {
    const root = await freshRoot();
    const svg = await readFile(join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1/favicon.svg"));
    const archive = await archiveAt(root, svg);
    await importProject({ archive, root, schema: 1, recordProvenance: true });
    const changedSvg = Buffer.from(svg.toString("utf8").replace('viewBox="0 0 64 64"', 'viewBox="0 0 32 32"'), "utf8");
    const changedArchive = await archiveAt(root, changedSvg);
    const plan = await planReconciliation({ archive: changedArchive, root });
    expect(plan.changed).toBe(true);
    let called = false;
    await executeReconciliationPlan(plan, { beforeStageCreate: () => { called = true; } });
    expect(called).toBe(true);
  });

  it("exposes private build retention and stops before build/preview promotion", async () => {
    const root = await freshRoot();
    const svg = await readFile(join(process.cwd(), "test/fixtures/tftn-icon-candidate-v1/favicon.svg"));
    const archive = await archiveAt(root, svg);
    await importProject({ archive, root, schema: 1 });
    await buildProject(root);
    const buildPlan = await planBuild(root);
    expect(inspectBuildPlanRetention(buildPlan).retainedBytes).toBeGreaterThan(0);
    await expect(executeBuild(buildPlan, { beforePromotion: () => { throw new Error("cancel"); } })).rejects.toThrow("cancel");
    expect((await readdir(join(root, "brand"))).filter((name) => name.includes("tfsb-stage") || name.includes("tfsb-backup"))).toEqual([]);

    await previewProject({ root });
    const previewPlan = await planPreview({ root });
    await expect(executePreviewPlan(previewPlan, { beforePromotion: () => { throw new Error("cancel"); } })).rejects.toThrow("cancel");
    expect((await readdir(root)).filter((name) => name === ".tfsb.lock" || name.startsWith(".tfsb-preview.tfsb-stage") || name.startsWith(".tfsb-preview.tfsb-backup"))).toEqual([]);
  });
});
