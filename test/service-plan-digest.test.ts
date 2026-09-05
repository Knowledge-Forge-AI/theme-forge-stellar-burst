import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  computePlanDigest,
  type PlanDigestEnvelope,
} from "../src/service-protocol/canonical-json.js";

const golden: PlanDigestEnvelope = {
  authority: {
    assetId: "stellar-burst",
    proposedDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  },
  handles: { project: "sha256:1111111111111111111111111111111111111111111111111111111111111111" },
  method: "asset.edit.plan",
  preState: {
    asset: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    project: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  },
  protocol: "tfsb.studio",
  protocolVersion: "1.0",
  summary: {
    affectedCanonicalPath: ".tfsb/assets/stellar-burst.toml",
    assetId: "stellar-burst",
    changed: true,
    changes: [],
    newDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    oldDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  },
};

describe("Studio plan canonical JSON", () => {
  it("reproduces the 799-byte golden preimage and digest", () => {
    const canonical = canonicalJson(golden);
    const preimage = Buffer.from(`tfsb-studio-plan-v1\n${canonical}`, "utf8");
    expect(preimage.byteLength).toBe(799);
    expect(computePlanDigest(golden)).toBe("sha256:794d808d8c7247c24b935f810b885816a7f516c6abd27bca7185c26e5313fd3b");
  });

  it("sorts keys by UTF-8 bytes recursively while preserving arrays", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], "é": true, a: ["二", "a"] })).toBe('{"a":["二","a"],"z":[{"a":1,"b":2}],"é":true}');
    expect(canonicalJson({ "e\u0301": 1, "é": 2 })).toBe('{"é":1,"é":2}');
    expect(canonicalJson("line\n\"\t\\\u0000")).toBe(JSON.stringify("line\n\"\t\\\u0000"));
  });

  it.each([
    ["undefined", undefined],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["function", () => undefined],
    ["symbol", Symbol("invalid")],
    ["bigint", BigInt(1)],
    ["date", new Date(0)],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it("rejects sparse arrays, accessors, symbols, and circular values", () => {
    expect(() => canonicalJson([, 1])).toThrow(TypeError);
    const withGetter = {} as { readonly value: number };
    Object.defineProperty(withGetter, "value", { enumerable: true, get: () => 1 });
    expect(() => canonicalJson(withGetter)).toThrow(TypeError);
    const withSymbol = { value: 1 };
    Object.defineProperty(withSymbol, Symbol("private"), { value: 2, enumerable: true });
    expect(() => canonicalJson(withSymbol)).toThrow(TypeError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(TypeError);
  });

  it("requires exactly the seven digest envelope fields", () => {
    expect(() => computePlanDigest({ ...golden, planToken: "ignored" } as PlanDigestEnvelope)).toThrow(TypeError);
    expect(() => computePlanDigest({ ...golden, monotonicCreationTime: 1 } as PlanDigestEnvelope)).toThrow(TypeError);
    expect(computePlanDigest({ ...golden })).toBe(computePlanDigest({ ...golden }));
  });
});
