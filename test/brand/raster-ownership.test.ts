import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { executeRasterExportPlan, inspectRasterExportState, planRasterExport } from "../../src/brand/export-plan.js";
import { rasterReceiptPath } from "../../src/brand/raster-receipt.js";
import { cleanupRoots, fakeRasterCapability, setupRasterProject } from "./raster-test-helper.js";

const roots: string[] = [];
afterEach(() => cleanupRoots(roots));

describe("raster output ownership", () => {
  it("distinguishes create, human ownership, exact ownership, drift, and missing output", async () => {
    const root = await setupRasterProject(roots), capability = fakeRasterCapability();
    expect((await inspectRasterExportState(root, capability)).entries[0]!.state).toBe("create");
    await mkdir(`${root}/public`); await writeFile(`${root}/public/icon.png`, "human");
    expect((await inspectRasterExportState(root, capability)).entries[0]!.state).toBe("RASTER_OUTPUT_OWNED_BY_HUMAN");
    await rm(`${root}/public/icon.png`);
    await executeRasterExportPlan(await planRasterExport(root, { profileId: "web-icons", capability }));
    expect((await inspectRasterExportState(root, capability)).entries[0]!.state).toBe("unchanged");
    await writeFile(`${root}/public/icon.png`, "tamper");
    expect((await inspectRasterExportState(root, capability)).entries[0]!.state).toBe("RASTER_OUTPUT_DRIFT");
    await rm(`${root}/public/icon.png`);
    expect((await inspectRasterExportState(root, capability)).entries[0]!.state).toBe("RASTER_OUTPUT_MISSING");
    expect(rasterReceiptPath("web-icons", "icon")).toBe(".tfsb/raster-receipts/web-icons/icon.receipt.json");
  });
});
