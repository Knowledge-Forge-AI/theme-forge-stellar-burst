import { describe, expect, it } from "vitest";

import { createStudioCapabilitiesV1_1, isQualifiedStudioRasterCapability, STUDIO_CAPABILITIES } from "../../src/service-protocol/v1-registry.js";

const qualified: any = {
  available: true,
  adapter: { descriptor: { adapterId: "resvg-png-v1", rendererPackage: "@resvg/resvg-wasm", rendererVersion: "2.6.2", rendererBuildDigest: "sha256:22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70", nodeMajor: 22, platformClaim: "darwin-arm64", qualificationId: "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11" } },
  qa: {},
};

describe("Studio brand capability", () => {
  it("keeps 1.0 exact and closes unavailable 1.1 raster state", () => {
    expect(STUDIO_CAPABILITIES).not.toHaveProperty("brand");
    const value = createStudioCapabilitiesV1_1({ available: false, code: "EXPORT_CAPABILITY_UNAVAILABLE", reason: "/private/reason" });
    expect(value.brand.raster).toEqual({ available: false });
    expect(value.brand.methods).toMatchObject({ qaBaselinePlan: false, exportPlan: false });
    expect(JSON.stringify(value)).not.toContain("private");
    expect(Object.isFrozen(value.brand)).toBe(true);
  });

  it("advertises mutation capability only for the exact qualified tuple", () => {
    expect(isQualifiedStudioRasterCapability(qualified)).toBe(true);
    const value = createStudioCapabilitiesV1_1(qualified);
    expect(value.brand.methods).toMatchObject({ qaBaselinePlan: true, exportPlan: true });
    expect(value.brand.raster).toEqual({ available: true, adapterId: "resvg-png-v1", rendererVersion: "2.6.2", qualificationId: "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11", platformClaim: "darwin-arm64" });
    expect(isQualifiedStudioRasterCapability({ ...qualified, adapter: { descriptor: { ...qualified.adapter.descriptor, nodeMajor: 23 } } })).toBe(false);
  });
});
