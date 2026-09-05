import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADVERTISED_METHODS_1_1, ADVERTISED_METHODS_1_2, BRAND_PLAN_METHODS, BRAND_READ_METHODS, BRAND_READ_METHODS_1_2, ERROR_REGISTRY,
  SERVER_NOTIFICATION_METHODS, SUPPORTED_CLIENT_NOTIFICATION_METHODS, SUPPORTED_REQUEST_METHODS_1_1, SUPPORTED_REQUEST_METHODS_1_2,
} from "../../src/service-protocol/v1-registry.js";
import { V1_1_TYPE_METHODS, V1_2_TYPE_METHODS } from "../../src/service-protocol/v1-types.js";
import { validateInboundMessage, validateResult } from "../../src/service-protocol/v1-validate.js";

const root = join(process.cwd(), "protocol/tfsb-studio-v1");
const json = (path: string): any => JSON.parse(readFileSync(join(root, path), "utf8"));
const hash = (path: string): string => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");

describe("Studio protocol 1.1 machine parity", () => {
  it("preserves every frozen 1.0 machine artifact byte-for-byte", () => {
    expect(hash("envelope.schema.json")).toBe("3f974c3b66bd300c6e144476fb918b56ca4cfed7daa1f1fcbe8f6f122167b3e5");
    expect(hash("requests.schema.json")).toBe("5fa687ed6434b4f0ec6288bf4285f4109ab63afe55e2235d52f04f8ed77a8827");
    expect(hash("results.schema.json")).toBe("5b8f0f057d0dbcabf1b5d83765e476baececd5e7cdb5696bfcb1ac1826f84ff1");
    expect(hash("inventory.json")).toBe("96fdbcf0c56c1890d44363c34c80d8dacfccb37196de8050ab2d1afc7a3e0f70");
  });

  it("preserves every frozen 1.1 machine artifact and example byte-for-byte", () => {
    expect(hash("requests-1.1.schema.json")).toBe("b5a10078862c8e03e951a67a8e7cd125c5d4d23619c3d32a9fb41a762629d54f");
    expect(hash("results-1.1.schema.json")).toBe("dee9513c61ed767e260d6dd16a13420c26f745850c7a6055cf6213e52571be60");
    expect(hash("inventory-1.1.json")).toBe("9d58e954e62169e87648814372a381653e9e69df5a0ce722251e6e46951dfe8a");
    expect(hash("examples/1.1/requests.json")).toBe("909ed14eb743a031324dd0b79527b6b5db88a12765c5ef2d8a4560f111e9f106");
    expect(hash("examples/1.1/results.json")).toBe("ee31e296abedf9f5ed45af73e5ef1c869f42860eb28fe172f45b0c721578a726");
  });

  it("has one exact 39/3/1 method inventory and the same 21 errors", () => {
    const inventory = json("inventory-1.1.json");
    expect(SUPPORTED_REQUEST_METHODS_1_1).toHaveLength(39);
    expect(SUPPORTED_CLIENT_NOTIFICATION_METHODS).toHaveLength(3);
    expect(SERVER_NOTIFICATION_METHODS).toHaveLength(1);
    expect(inventory.advertisedMethods).toEqual([...ADVERTISED_METHODS_1_1]);
    expect(Object.keys(inventory.errors)).toHaveLength(21);
    expect(inventory.errors).toEqual(Object.fromEntries(Object.entries(ERROR_REGISTRY).map(([key, value]) => [key, value.numeric])));
    expect([...V1_1_TYPE_METHODS]).toEqual([...ADVERTISED_METHODS_1_1]);
  });

  it("validates every 1.1 request example and covers every brand method", () => {
    const requests = json("examples/1.1/requests.json");
    for (const request of requests) expect(() => validateInboundMessage(request)).not.toThrow();
    const methods = new Set(requests.map((request: any) => request.method));
    expect([...BRAND_READ_METHODS, ...BRAND_PLAN_METHODS].filter((method) => !methods.has(method))).toEqual([]);
    expect(methods).toContain("initialize");
    expect(methods).toContain("source.open");
  });

  it("validates every result example and covers every brand result", () => {
    const results = json("examples/1.1/results.json");
    validateResult("initialize", results.initialize.result);
    for (const [method, result] of Object.entries(results)) if (method !== "initialize") validateResult(method as any, result);
    for (const method of [...BRAND_READ_METHODS, ...BRAND_PLAN_METHODS]) expect(results).toHaveProperty(method);
  });

  it("keeps both new schemas closed, parseable, and covering all brand methods", () => {
    const requests = json("requests-1.1.schema.json"); const results = json("results-1.1.schema.json");
    expect(requests.$id).toMatch(/requests-1\.1/); expect(results.$id).toMatch(/results-1\.1/);
    expect(JSON.stringify(requests)).toContain('"additionalProperties":false');
    expect(JSON.stringify(results)).toContain('"additionalProperties":false');
    const requestSchemaMethods = new Set<string>();
    for (const entry of requests.anyOf) {
      const prop = entry?.properties?.method;
      if (prop?.const) requestSchemaMethods.add(prop.const);
      if (Array.isArray(prop?.enum)) for (const m of prop.enum) requestSchemaMethods.add(m);
    }
    for (const method of [...BRAND_READ_METHODS, ...BRAND_PLAN_METHODS]) {
      expect(requestSchemaMethods.has(method)).toBe(true);
    }
    const resultPlanMethods = results.$defs.planResult.properties.method.enum;
    expect(new Set(resultPlanMethods)).toEqual(new Set(BRAND_PLAN_METHODS));
  });

  it("rejects unknown fields inside closed brand result objects", () => {
    const results = json("examples/1.1/results.json");
    expect(() => validateResult("brand.status", { ...results["brand.status"], raster: { available: false, path: "/private" } })).toThrow();
    expect(() => validateResult("brand.qa.result.get", { ...results["brand.qa.result.get"], counts: { ...results["brand.qa.result.get"].counts, warning: 1 } })).toThrow();
    expect(() => validateResult("brand.derive.plan", { ...results["brand.derive.plan"], summary: { ...results["brand.derive.plan"].summary, authority: {} } })).toThrow();
  });

  it("has exact 41/3/1 protocol 1.2 parity and validates every new example", () => {
    expect(hash("inventory-1.2.json")).toBe("b620544ad644a7293313212a9585cd9e07af93608f2beac4e36b4bc99d812638");
    expect(hash("requests-1.2.schema.json")).toBe("e63252413eaebc2f5a73ad0973d48a51908f8d0604b09440774948bd935daf89");
    expect(hash("results-1.2.schema.json")).toBe("d6259a45a4da2185761098ebf6f8d0f5ff80f08f41d3e34a4a3d69f792760fd1");
    expect(hash("examples/1.2/requests.json")).toBe("a4ad2af46d5fbc4e2a4512e857d27e4ba8176699fb37c7dc1e976d20393a8ea5");
    expect(hash("examples/1.2/results.json")).toBe("5627d68c999f22434e624dd1f2405030005fdac01f05a395fa8131343a4c895e");
    const inventory = json("inventory-1.2.json");
    expect(SUPPORTED_REQUEST_METHODS_1_2).toHaveLength(41);
    expect(inventory.advertisedMethods).toEqual([...ADVERTISED_METHODS_1_2]);
    expect(inventory.errors).toEqual(Object.fromEntries(Object.entries(ERROR_REGISTRY).map(([key, value]) => [key, value.numeric])));
    expect([...V1_2_TYPE_METHODS]).toEqual([...ADVERTISED_METHODS_1_2]);
    const requests = json("examples/1.2/requests.json");
    for (const request of requests) expect(() => validateInboundMessage(request)).not.toThrow();
    const methods = new Set(requests.map((request: any) => request.method));
    for (const method of BRAND_READ_METHODS_1_2) expect(methods).toContain(method);
    const results = json("examples/1.2/results.json");
    validateResult("initialize", results.initialize.result);
    for (const [method, result] of Object.entries(results)) if (method !== "initialize") validateResult(method as any, result);
    const requestSchema = json("requests-1.2.schema.json"), resultSchema = json("results-1.2.schema.json");
    expect(requestSchema.$id).toMatch(/requests-1\.2/); expect(resultSchema.$id).toMatch(/results-1\.2/);
    expect(JSON.stringify(requestSchema)).toContain('"additionalProperties":false');
    expect(JSON.stringify(resultSchema)).toContain('"additionalProperties":false');

    const visual = structuredClone(results["brand.visual.evidence.get"]);
    visual.renderer.qualificationId = `sha256:${"0".repeat(64)}`;
    expect(() => validateResult("brand.visual.evidence.get", visual)).toThrow();
  });
});
