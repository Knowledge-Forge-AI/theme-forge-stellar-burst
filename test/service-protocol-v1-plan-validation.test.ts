import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ValidationError, validateInboundMessage, validateParams, validateResult } from "../src/service-protocol/v1-validate.js";
import { repoPath } from "./helpers.js";

const protocolRoot = repoPath("protocol/tfsb-studio-v1");
const nonce = "REDACTED_EXAMPLE_NONCE";
const projectHandle = "project_REDACTED_EXAMPLE_HANDLE";
const sourceHandle = "source_REDACTED_EXAMPLE_HANDLE";
const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function request(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id: `${method}-test`, method, params };
}

describe("TFSB45B1 closed Studio protocol contract", () => {
  it("accepts every active plan request/result example", () => {
    const methods = [
      "asset.edit.plan", "project.import.plan", "project.reconcile.plan", "project.migrate.plan",
      "project.fmt.plan", "project.build.plan", "project.install.plan", "preview.plan",
      "plan.discard", "plan.apply",
    ] as const;
    for (const method of methods) {
      const stem = method.replaceAll(".", "-");
      const requestValue = JSON.parse(readFileSync(`${protocolRoot}/examples/${stem}-request.json`, "utf8")) as Record<string, unknown>;
      expect(() => validateInboundMessage(requestValue)).not.toThrow();
      const resultValue = JSON.parse(readFileSync(`${protocolRoot}/examples/${stem}-result.json`, "utf8")) as { result: unknown };
      expect(() => validateResult(method, resultValue.result)).not.toThrow();
    }
  });

  it("accepts typed open modes and auxiliary purposes while preserving omission defaults", () => {
    expect(validateParams("project.open", { sessionNonce: nonce, path: "/selected/project" })).toEqual({ sessionNonce: nonce, path: "/selected/project" });
    expect(validateParams("project.open", { sessionNonce: nonce, path: "/selected/project", mode: "import-target" })).toMatchObject({ mode: "import-target" });
    expect(validateParams("source.open", { sessionNonce: nonce, path: "/selected/map.toml", purpose: "source-map" })).toMatchObject({ purpose: "source-map" });
    expect(() => validateInboundMessage(request("project.open", { sessionNonce: nonce, path: "/selected/project", mode: "unknown" }))).toThrow(ValidationError);
    expect(() => validateInboundMessage(request("source.open", { sessionNonce: nonce, path: "/selected/map.toml", purpose: "content-map" }))).toThrow(ValidationError);
    expect(() => validateInboundMessage(request("project.fmt.plan", { sessionNonce: nonce, projectHandle: "workspace_wrong_kind" }))).not.toThrow();
  });

  it("rejects plan unknown fields, absolute paths, unsafe identities, and invalid vocabularies", () => {
    const base = { sessionNonce: nonce, projectHandle, sourceHandle };
    expect(() => validateInboundMessage(request("project.fmt.plan", { sessionNonce: nonce, projectHandle, path: "/tmp/injected" }))).toThrow(ValidationError);
    expect(() => validateInboundMessage(request("asset.edit.plan", { sessionNonce: nonce, projectHandle, assetId: "mark", proposedToml: "x", extra: true }))).toThrow(ValidationError);
    expect(() => validateInboundMessage(request("project.import.plan", { ...base, schemaVersion: 2, selections: ["../escape"] }))).toThrow(ValidationError);
    expect(() => validateInboundMessage(request("project.import.plan", { ...base, schemaVersion: 2, selections: ["a\\b.svg"] }))).toThrow(ValidationError);
    expect(() => validateInboundMessage(request("preview.plan", { sessionNonce: nonce, projectHandle, outputDirectory: "/absolute" }))).toThrow(ValidationError);
    expect(() => validateInboundMessage(request("project.reconcile.plan", { ...base, resolutions: [{ key: "asset:mark", choice: "unknown" }] }))).toThrow(ValidationError);
    expect(() => validateInboundMessage(request("project.import.plan", { ...base, schemaVersion: 2, selections: ["mark.svg"], shardManifestHandle: sourceHandle }))).toThrow(ValidationError);
  });

  it("recursively closes plan summaries and reconciliation vocabularies", () => {
    const summary = {
      assetId: "mark", affectedCanonicalPath: ".tfsb/assets/mark.toml", oldDigest: digest, newDigest: digest,
      changed: true, changes: [],
    };
    expect(() => validateResult("asset.edit.plan", { planToken: token, planDigest: digest, expiresInMs: 600000, method: "asset.edit.plan", summary })).not.toThrow();
    expect(() => validateResult("asset.edit.plan", { planToken: token, planDigest: digest, expiresInMs: 600000, method: "asset.edit.plan", summary: { ...summary, semanticChanges: [] } })).toThrow(ValidationError);
    const record = { key: "asset:mark", kind: "asset", classification: "NEW_ASSET", plannedAction: "add_canonical", requiredAuthority: "none", blocker: false };
    expect(() => validateResult("project.reconcile.plan", { planToken: token, planDigest: digest, expiresInMs: 600000, method: "project.reconcile.plan", summary: { sourceKind: "archive", changed: true, pending: false, blocked: false, records: [record] } })).not.toThrow();
    for (const field of ["classification", "plannedAction", "requiredAuthority"] as const) {
      expect(() => validateResult("project.reconcile.plan", { planToken: token, planDigest: digest, expiresInMs: 600000, method: "project.reconcile.plan", summary: { sourceKind: "archive", changed: true, pending: false, blocked: false, records: [{ ...record, [field]: "outside-contract" }] } })).toThrow(ValidationError);
    }
  });

  it("enforces the activated initialize capabilities and limits", () => {
    const result = JSON.parse(readFileSync(`${protocolRoot}/examples/initialize-result.json`, "utf8")) as { result: unknown };
    expect(() => validateResult("initialize", result.result)).not.toThrow();
    const invalid = JSON.parse(JSON.stringify(result.result)) as { capabilities: { methods: { mutationPlans: boolean }; limits: { maxActivePlans: number } } };
    invalid.capabilities.methods.mutationPlans = false;
    expect(() => validateResult("initialize", invalid)).toThrow(ValidationError);
    invalid.capabilities.methods.mutationPlans = true;
    invalid.capabilities.limits.maxActivePlans = 5;
    expect(() => validateResult("initialize", invalid)).toThrow(ValidationError);
  });
});
