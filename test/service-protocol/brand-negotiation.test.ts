import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { StudioServer } from "../../src/service-protocol/server.js";
import { STUDIO_CAPABILITIES } from "../../src/service-protocol/v1-registry.js";

async function request(minVersion: string, maxVersion: string): Promise<any> {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let buffer = "";
  const response = new Promise<any>((resolve, reject) => {
    output.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
    });
    error.on("data", (chunk) => reject(new Error(chunk.toString("utf8"))));
  });
  new StudioServer({ input, output, error }).start();
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocol: "tfsb.studio", minVersion, maxVersion, client: { name: "vitest", version: "1" }, capabilities: { progress: false, cancellation: true } } })}\n`);
  return await response;
}

describe("Studio brand protocol negotiation", () => {
  it.each([
    ["1.0", "1.0", "1.0"],
    ["1.0", "1.1", "1.1"],
    ["1.1", "1.1", "1.1"],
    ["1.0", "1.2", "1.2"],
    ["1.1", "1.2", "1.2"],
    ["1.2", "1.2", "1.2"],
  ])("selects the highest supported minor in %s..%s", async (min, max, selected) => {
    const response = await request(min, max);
    expect(response.result.selectedVersion).toBe(selected);
  });

  it.each([["1.3", "1.9"], ["2.0", "2.1"], ["1.1", "1.0"], ["1", "1.1"], ["wat", "1.1"]])(
    "rejects unsupported or malformed range %s..%s",
    async (min, max) => expect(await request(min, max)).toMatchObject({ error: { data: { code: "PROTOCOL_VERSION_UNSUPPORTED" } } }),
  );

  it("preserves the exact closed 1.0 capability shape", async () => {
    const response = await request("1.0", "1.0");
    expect(response.result.capabilities).toEqual(STUDIO_CAPABILITIES);
    expect(response.result.capabilities).not.toHaveProperty("brand");
    expect(Object.keys(response.result).sort()).toEqual(["capabilities", "protocol", "selectedVersion", "server", "sessionNonce"]);
  });

  it("advertises one closed brand capability only for 1.1", async () => {
    const response = await request("1.1", "1.1");
    expect(response.result.capabilities.brand).toMatchObject({
      schemaVersion: 1,
      methods: { status: true, familyList: true, tokenList: true, recipeGraph: true, qaProfileGet: true, qaResultGet: true, diff: true, consumerProfileList: true, consumerLockStatus: true, exportCapability: true, exportStatus: true, derivePlan: true, consumerInstallPlan: true, consumerSyncPlan: true },
      sourcePurposes: { brandBundle: true, npmInstalledPackage: true },
      limits: { pageSizeMin: 1, pageSizeDefault: 64, pageSizeMax: 128, maxSourcePackages: 8, maxSelectedProfiles: 8, maxQaResultBytes: 16_777_216, maxDiffResultBytes: 16_777_216, maxExportOutputs: 128 },
    });
    expect(Object.keys(response.result.capabilities.brand).sort()).toEqual(["limits", "methods", "raster", "schemaVersion", "sourcePurposes"]);
    expect(response.result.capabilities.brand.methods.qaBaselinePlan).toBe(response.result.capabilities.brand.raster.available);
    expect(response.result.capabilities.brand.methods.exportPlan).toBe(response.result.capabilities.brand.raster.available);
  });

  it("adds only the closed 1.2 read and visual capability fields", async () => {
    const response = await request("1.2", "1.2");
    expect(response.result.capabilities.brand.methods).toMatchObject({ qaProfileList: true, visualEvidenceGet: false });
    expect(response.result.capabilities.brand.visualEvidence).toEqual({ available: false });
    expect(Object.keys(response.result.capabilities.brand).sort()).toEqual(["limits", "methods", "raster", "schemaVersion", "sourcePurposes", "visualEvidence"]);
  });
});
