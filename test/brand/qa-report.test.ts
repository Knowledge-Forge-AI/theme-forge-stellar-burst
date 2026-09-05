import { describe, expect, it } from "vitest";

import { createBrandQaResult, projectBrandQaResultHtml, projectBrandQaResultMarkdown, serializeBrandQaResult, type BrandQaCaseResult } from "../../src/index.js";
import { readRepoFile } from "../helpers.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}` as const;

function result(records: readonly BrandQaCaseResult[]) {
  return createBrandQaResult({ profileId: "release", qaDigest: digest("1"), brandSystemDigest: digest("2"), results: records, selectedCaseIds: records.map((entry) => entry.caseId) });
}

function record(caseId: string, status: BrandQaCaseResult["status"], capabilityRequired = false): BrandQaCaseResult {
  return { caseId, kind: "canvas", status, capability: capabilityRequired ? "renderer" : "semantic-core-v1", capabilityRequired, measurements: { text: "<script>|\n" }, diagnostics: [], evaluations: [{ target: { assetId: "asset" }, status, measurements: {}, diagnostics: [] }] };
}

describe("brand QA result and reports", () => {
  it("enforces exit precedence 1 > 3 > 2 > 0", () => {
    expect(result([record("pass", "pass")]).exitCode).toBe(0);
    expect(result([record("fail", "fail")]).exitCode).toBe(2);
    expect(result([record("fail", "fail"), record("unavailable", "unavailable", true)]).exitCode).toBe(3);
    expect(result([record("fail", "fail"), record("unavailable", "unavailable", true), record("error", "error")]).exitCode).toBe(1);
    expect(result([record("optional", "unavailable", false)]).exitCode).toBe(0);
  });

  it("is deterministic, sorted, complete, and rejects copied digest tamper", () => {
    const value = result([record("z-case", "pass"), record("a-case", "pass")]);
    expect(value.results.map((entry) => entry.caseId)).toEqual(["a-case", "z-case"]);
    expect(serializeBrandQaResult(value)).toBe(serializeBrandQaResult(value));
    expect(() => serializeBrandQaResult({ ...value, resultDigest: digest("9") })).toThrow(/digest/u);
    expect(() => createBrandQaResult({ profileId: "release", qaDigest: digest("1"), brandSystemDigest: digest("2"), results: [record("a", "pass")], selectedCaseIds: ["a", "b"] })).toThrow(/exactly one/u);
  });

  it("projects escaped Markdown and scriptless offline HTML without byte leakage", () => {
    const value = result([record("<script>|case", "pass")]);
    const markdown = projectBrandQaResultMarkdown(value);
    const html = projectBrandQaResultHtml(value);
    expect(markdown).toContain("\\|case");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toMatch(/<script|\son[a-z]+\s*=|https?:|data:/iu);
    expect(html).not.toContain("rgba8");
    expect(html).not.toContain("pngBytes");
  });

  it("keeps the documented result example on the executable digest contract", () => {
    expect(() => serializeBrandQaResult(JSON.parse(readRepoFile("docs/examples/v0.4/brand-system/results/brand-qa-result.json")))).not.toThrow();
  });
});
