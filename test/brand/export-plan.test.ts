import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { executeRasterExportPlan, planRasterExport } from "../../src/brand/export-plan.js";
import { checkProject } from "../../src/check.js";
import { cleanupRoots, fakeRasterCapability, setupRasterProject } from "./raster-test-helper.js";

const roots: string[] = [];
afterEach(() => cleanupRoots(roots));

describe("authentic raster export plans", () => {
  it("deep-freezes summaries and rejects copied authority", async () => {
    const root = await setupRasterProject(roots), capability = fakeRasterCapability();
    const plan = await planRasterExport(root, { profileId: "web-icons", capability });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.outputs)).toBe(true);
    await expect(executeRasterExportPlan({ ...plan } as typeof plan)).rejects.toThrow(/private authority/);
    const dry = await executeRasterExportPlan(plan, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(existsSync(`${root}/public/icon.png`)).toBe(false);
    await expect(executeRasterExportPlan(plan)).rejects.toThrow(/private authority|consumed/);
  });

  it("creates once and makes a semantic repeat a no-op", async () => {
    const root = await setupRasterProject(roots), capability = fakeRasterCapability();
    const first = await planRasterExport(root, { profileId: "web-icons", capability });
    expect(first.counts).toEqual({ create: 1, update: 0, unchanged: 0 });
    expect((await executeRasterExportPlan(first)).writtenOutputs).toBe(1);
    expect((await checkProject(root)).sourceChanged).toBe(false);
    const second = await planRasterExport(root, { profileId: "web-icons", capability });
    expect(second.counts).toEqual({ create: 0, update: 0, unchanged: 1 });
    expect((await executeRasterExportPlan(second)).writtenOutputs).toBe(0);
  });

  it("rejects equal absent-state impersonation through parent replacement", async () => {
    const root = await setupRasterProject(roots), capability = fakeRasterCapability();
    await mkdir(`${root}/public`);
    const plan = await planRasterExport(root, { profileId: "web-icons", capability });
    await rename(`${root}/public`, `${root}/public-old`); await mkdir(`${root}/public`);
    await expect(executeRasterExportPlan(plan)).rejects.toThrow(/parent/);
    expect(existsSync(`${root}/public/icon.png`)).toBe(false);
  });
});
