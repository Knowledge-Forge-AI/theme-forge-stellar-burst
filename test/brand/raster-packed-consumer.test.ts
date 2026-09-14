import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { bundleBrandProject } from "../../src/brand/brand-bundle.js";
import { importBrandProject } from "../../src/brand/brand-import.js";
import { executeRasterExportPlan, planRasterExport } from "../../src/brand/export-plan.js";
import { cleanupRoots, fakeRasterCapability, setupRasterProject } from "./raster-test-helper.js";

const roots: string[] = [];
afterEach(() => cleanupRoots(roots));

describe("raster packed-consumer package boundaries", () => {
  it("keeps the base package renderer-free and pins the independent companion backend", async () => {
    const base = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    const companion = JSON.parse(await readFile(new URL("../../packages/tfsb-raster-resvg/package.json", import.meta.url), "utf8"));
    expect(base.dependencies).toEqual({ "@xmldom/xmldom": "0.9.12", fflate: "0.8.3", "smol-toml": "1.8.0" });
    expect(base.dependencies).not.toHaveProperty("@knowledge-forge-ai/tfsb-raster-resvg");
    expect(base.dependencies).not.toHaveProperty("@resvg/resvg-wasm");
    expect(companion.dependencies).toEqual({ "@resvg/resvg-wasm": "2.6.2" });
    expect(companion.scripts).not.toHaveProperty("install");
    expect(companion.scripts).not.toHaveProperty("postinstall");
  });

  it("carries exact export authority through bundle/import without generated raster state", async () => {
    const source = await setupRasterProject(roots), exportBytes = await readFile(`${source}/.tfsb/brand-exports.toml`);
    await executeRasterExportPlan(await planRasterExport(source, { profileId: "web-icons", capability: fakeRasterCapability() }));
    await bundleBrandProject({ root: source, output: "brand.zip" });
    const zip = unzipSync(await readFile(`${source}/brand.zip`));
    expect(zip["brand/brand-exports.toml"]).toEqual(new Uint8Array(exportBytes));
    expect(Object.keys(zip).some((path) => path.endsWith(".png") || path.includes("raster-receipts"))).toBe(false);
    const target = await mkdtemp(join(tmpdir(), "tfsb-raster-import-")); roots.push(target);
    await importBrandProject({ archive: `${source}/brand.zip`, root: target });
    expect(await readFile(`${target}/.tfsb/brand-exports.toml`)).toEqual(exportBytes);
    expect(await readFile(`${target}/public/icon.png`).catch(() => undefined)).toBeUndefined();
  });
});
