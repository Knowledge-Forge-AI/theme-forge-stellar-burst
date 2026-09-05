import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { executeRasterExportPlan, inspectRasterExportState, planRasterExport, type RasterTransactionEvent } from "../../src/brand/export-plan.js";
import { cleanupRoots, fakeRasterCapability, setupRasterProject } from "./raster-test-helper.js";

const roots: string[] = [];
afterEach(() => cleanupRoots(roots));

describe("raster output transaction", () => {
  it("promotes PNG before receipt and rolls both back on a receipt fault", async () => {
    const root = await setupRasterProject(roots), plan = await planRasterExport(root, { profileId: "web-icons", capability: fakeRasterCapability() });
    const events: string[] = [];
    await expect(executeRasterExportPlan(plan, { hooks: { onEvent(event) { events.push(event); if (event === "before-receipt-promotion") throw new Error("fault"); } } })).rejects.toThrow(/rolled back/);
    expect(events.indexOf("after-output-promotion")).toBeLessThan(events.indexOf("before-receipt-promotion"));
    expect(existsSync(`${root}/public/icon.png`)).toBe(false);
    expect(existsSync(`${root}/.tfsb/raster-receipts/web-icons/icon.receipt.json`)).toBe(false);
    expect((await readdir(root)).some((name) => name.startsWith(".tfsb-raster-transaction-"))).toBe(false);
  });

  it("rejects a changed sibling stage before publication", async () => {
    const root = await setupRasterProject(roots), plan = await planRasterExport(root, { profileId: "web-icons", capability: fakeRasterCapability() });
    let changed = false;
    await expect(executeRasterExportPlan(plan, { hooks: { async onEvent(event, relativePath) { if (!changed && event === "after-stage" && relativePath === "public/icon.png") { const stage = (await readdir(`${root}/public`)).find((name) => name.includes(".tfsb-raster-stage-")); if (stage === undefined) throw new Error("Stage missing."); await writeFile(`${root}/public/${stage}`, "tamper"); changed = true; } } } })).rejects.toThrow(/rolled back/);
    expect(changed).toBe(true);
    expect(existsSync(`${root}/public/icon.png`)).toBe(false);
  });

  it.each(["after-stage", "after-journal", "before-output-promotion", "after-output-promotion", "before-receipt-promotion", "after-receipt-promotion"] satisfies RasterTransactionEvent[])("rolls back a fault at %s", async (fault) => {
    const root = await setupRasterProject(roots), plan = await planRasterExport(root, { profileId: "web-icons", capability: fakeRasterCapability() });
    let injected = false;
    await expect(executeRasterExportPlan(plan, { hooks: { onEvent(event) { if (!injected && event === fault) { injected = true; throw new Error("fault"); } } } })).rejects.toThrow(/rolled back/);
    expect(injected).toBe(true); expect(existsSync(`${root}/public/icon.png`)).toBe(false); expect(existsSync(`${root}/.tfsb/raster-receipts/web-icons/icon.receipt.json`)).toBe(false);
  });

  it.each(["before-backup", "after-backup"] satisfies RasterTransactionEvent[])("restores prior owned bytes after %s fault", async (fault) => {
    const root = await setupRasterProject(roots), original = fakeRasterCapability("1"); await executeRasterExportPlan(await planRasterExport(root, { profileId: "web-icons", capability: original }));
    const updated = fakeRasterCapability("2"), plan = await planRasterExport(root, { profileId: "web-icons", capability: updated }); expect(plan.counts.update).toBe(1);
    await expect(executeRasterExportPlan(plan, { hooks: { onEvent(event) { if (event === fault) throw new Error("fault"); } } })).rejects.toThrow(/rolled back/);
    expect((await inspectRasterExportState(root, original)).entries[0]!.state).toBe("unchanged");
  });

  it.each(["before-cleanup", "after-cleanup"] satisfies RasterTransactionEvent[])("retains recovery journal after committed %s fault", async (fault) => {
    const root = await setupRasterProject(roots), plan = await planRasterExport(root, { profileId: "web-icons", capability: fakeRasterCapability() });
    await expect(executeRasterExportPlan(plan, { hooks: { onEvent(event) { if (event === fault) throw new Error("fault"); } } })).rejects.toThrow(/cleanup residue/);
    expect(existsSync(`${root}/public/icon.png`)).toBe(true); expect((await readdir(root)).some((name) => name.startsWith(".tfsb-raster-transaction-"))).toBe(true);
  });

  it.each(["before-rollback", "after-rollback"] satisfies RasterTransactionEvent[])("reports recovery required when %s handling fails", async (fault) => {
    const root = await setupRasterProject(roots), plan = await planRasterExport(root, { profileId: "web-icons", capability: fakeRasterCapability() });
    await expect(executeRasterExportPlan(plan, { hooks: { onEvent(event) { if (event === "before-output-promotion" || event === fault) throw new Error("fault"); } } })).rejects.toThrow(/retained recovery residue/);
    expect(existsSync(`${root}/public/icon.png`)).toBe(false); expect((await readdir(root)).some((name) => name.startsWith(".tfsb-raster-transaction-"))).toBe(true);
  });
});
