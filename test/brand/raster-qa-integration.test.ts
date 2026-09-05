import { afterEach, describe, expect, it } from "vitest";

import { runLoadedBrandQaProfile } from "../../src/brand/qa-semantic.js";
import { loadCanonicalProject } from "../../src/project.js";
import { cleanupRoots, fakeRasterCapability, setupRasterProject } from "./raster-test-helper.js";

const roots: string[] = [];
afterEach(() => cleanupRoots(roots));

describe("raster QA integration", () => {
  it("keeps required visual QA unavailable without the companion and uses the same closed capability when supplied", async () => {
    const root = await setupRasterProject(roots, { qa: true }), project = await loadCanonicalProject(root, "check");
    const absent = await runLoadedBrandQaProfile(project, "visual");
    expect(absent.exitCode).toBe(3);
    const capability = fakeRasterCapability(); if (!capability.available) throw new Error("Fake raster capability unexpectedly unavailable.");
    const present = await runLoadedBrandQaProfile(project, "visual", capability.qa);
    expect(present.exitCode, JSON.stringify(present)).toBe(0);
    expect(present.renderer?.id).toBe("resvg-png-v1");
  });
});
