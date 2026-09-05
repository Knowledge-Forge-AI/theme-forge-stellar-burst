import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ADVERTISED_METHODS, ERROR_REGISTRY, UNAVAILABLE_PLAN_METHODS } from "../src/service-protocol/v1-registry.js";
import { ValidationError, validateInboundMessage, validateResult } from "../src/service-protocol/v1-validate.js";
import { V1_TYPE_ERROR_CODES, V1_TYPE_METHODS } from "../src/service-protocol/v1-types.js";
import { repoPath } from "./helpers.js";

const protocolRoot = repoPath("protocol/tfsb-studio-v1");
const inventory = JSON.parse(readFileSync(join(protocolRoot, "inventory.json"), "utf8")) as {
  advertisedMethods: string[]; unavailableMethods: string[]; errors: Record<string, number>;
};

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesBelow(join(root, entry.name)) : [join(root, entry.name)]);
}

describe("studio protocol inventory and closed validators", () => {
  it("keeps runtime, type witness, schema inventory, and frozen errors in parity", () => {
    expect([...ADVERTISED_METHODS]).toEqual([...V1_TYPE_METHODS]);
    expect(inventory.advertisedMethods).toEqual([...ADVERTISED_METHODS]);
    expect(inventory.unavailableMethods).toEqual([...UNAVAILABLE_PLAN_METHODS]);
    expect(Object.keys(inventory.errors)).toEqual([...V1_TYPE_ERROR_CODES]);
    expect(inventory.errors).toEqual(Object.fromEntries(Object.entries(ERROR_REGISTRY).map(([key, value]) => [key, value.numeric])));
    for (const name of readdirSync(protocolRoot).filter((value) => value.endsWith(".json"))) expect(() => JSON.parse(readFileSync(join(protocolRoot, name), "utf8"))).not.toThrow();
    for (const file of filesBelow(join(protocolRoot, "examples")).filter((value) => value.endsWith(".json"))) expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
  });

  it("validates examples and rejects unknown envelope and parameter keys", () => {
    const initialize = JSON.parse(readFileSync(join(protocolRoot, "examples/initialize-request.json"), "utf8"));
    expect(validateInboundMessage(initialize)).toMatchObject({ method: "initialize", id: "init-1" });
    for (const [file, method] of [
      ["initialize-result.json", "initialize"], ["project-open-result.json", "project.open"],
      ["asset-list-result.json", "asset.list"], ["asset-get-result.json", "asset.get"],
      ["source-analyze-result.json", "source.analyze"],
    ] as const) {
      const example = JSON.parse(readFileSync(join(protocolRoot, "examples", file), "utf8")) as { result: unknown };
      expect(() => validateResult(method, example.result)).not.toThrow();
    }
    expect(() => validateInboundMessage({ ...initialize, extra: true })).toThrow(ValidationError);
    expect(() => validateInboundMessage({ jsonrpc: "2.0", id: "x", method: "project.list", params: { sessionNonce: "n", projectHandle: "project_x", path: "/tmp/injected" } })).toThrow(ValidationError);
    expect(() => validateInboundMessage({ jsonrpc: "2.0", id: "x", method: "asset.list", params: { sessionNonce: "n", scope: { kind: "project", projectHandle: "project_x" }, pageSize: 0 } })).toThrow(ValidationError);
    expect(() => validateInboundMessage({ jsonrpc: "2.0", id: "", method: "shutdown", params: { sessionNonce: "n" } })).toThrow(ValidationError);
  });

  it("permits absolute paths only in the three typed open methods", () => {
    const nonce = "n";
    for (const method of ["workspace.open", "project.open", "source.open"] as const) {
      expect(validateInboundMessage({ jsonrpc: "2.0", id: method, method, params: { sessionNonce: nonce, path: "/tmp/selected" } })).toMatchObject({ method });
    }
    for (const method of ["project.list", "preview.status"] as const) {
      expect(() => validateInboundMessage({ jsonrpc: "2.0", id: method, method, params: { sessionNonce: nonce, projectHandle: "project_x", path: "/tmp/injected" } })).toThrow(ValidationError);
    }
  });

  it("keeps the shipped protocol artifact free of private paths and live-looking secrets", () => {
    const files = [
      ...readdirSync(protocolRoot, { withFileTypes: true }).filter((value) => value.isFile() && !value.name.endsWith(".md")).map((value) => join(protocolRoot, value.name)),
      ...filesBelow(join(protocolRoot, "examples")),
    ];
    const payload = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(payload).not.toContain("/Users/");
    expect(payload).not.toContain("FAKE_SECRET");
    expect(payload).not.toContain("BEGIN PRIVATE KEY");
    expect(payload).not.toContain("lair001");
  });
});
