import { describe, expect, it } from "vitest";

import { computeAssetSemanticDigest, computeCompanionByteDigest } from "../src/digests.js";
import { parseImportProvenance, serializeImportProvenance } from "../src/provenance.js";
import { parseAssetToml } from "../src/toml.js";
import { readRepoFile, unwrap } from "./helpers.js";

describe("closed deterministic import provenance", () => {
  it("parses the controlling example and serializes independently to identical bytes", () => {
    const source = readRepoFile("docs/examples/v0.2/provenance.json");
    const first = unwrap(parseImportProvenance(source, "provenance.json"));
    const firstBytes = serializeImportProvenance(first);
    const secondBytes = serializeImportProvenance(unwrap(parseImportProvenance(firstBytes)));
    expect(secondBytes).toBe(firstBytes);
    expect(firstBytes.endsWith("\n")).toBe(true);
    expect(firstBytes.endsWith("\n\n")).toBe(false);
    expect(firstBytes.indexOf('"type": "companion"')).toBeGreaterThan(firstBytes.lastIndexOf('"type": "asset"'));
  });

  it.each([
    ["unknown top-level field", (value: any) => { value.extra = true; }, "PROVENANCE_UNKNOWN_FIELD"],
    ["uppercase digest", (value: any) => { value.records[0].archiveDigest = `sha256:${"A".repeat(64)}`; }, "PROVENANCE_INVALID_DIGEST"],
    ["asset/path disagreement", (value: any) => { value.records[0].canonicalPath = ".tfsb/assets/other.toml"; }, "PROVENANCE_PATH_MISMATCH"],
    ["duplicate record", (value: any) => { value.records.push(value.records[0]); }, "PROVENANCE_DUPLICATE_RECORD"],
    ["portable entry collision", (value: any) => { value.records[1].entryName = value.records[0].entryName.toUpperCase(); }, "PROVENANCE_DUPLICATE_RECORD"],
    ["impossible absence", (value: any) => { value.records[0].canonicalState = "absent"; }, "PROVENANCE_IMPOSSIBLE_STATE"],
    ["non-normalized entry", (value: any) => { value.records[0].entryName = "dir/../asset.svg"; }, "PROVENANCE_INVALID_ENTRY"],
    ["unsupported digest basis", (value: any) => { value.records[0].digestBasis = "future"; }, "PROVENANCE_UNSUPPORTED_DIGEST_BASIS"],
    ["unsafe companion path", (value: any) => { value.records[3].canonicalPath = ".tfsb/companions/bad\\README.md"; }, "PROVENANCE_INVALID_PATH"],
  ])("rejects %s", (_name, mutate, code) => {
    const value = JSON.parse(readRepoFile("docs/examples/v0.2/provenance.json"));
    mutate(value);
    const parsed = parseImportProvenance(JSON.stringify(value));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics[0]?.code).toBe(code);
  });

  it("pins semantic asset and exact companion digest behavior", () => {
    const source = readRepoFile("docs/examples/v0.1/assets/favicon.toml");
    const asset = unwrap(parseAssetToml(source));
    expect(computeAssetSemanticDigest(asset)).toBe("sha256:5af6adc4cb20655cf646c1265ca2c3386bbc812ad20ae61f54426e9a519be9d5");
    expect(computeAssetSemanticDigest(unwrap(parseAssetToml(`# ignored\n${source}`)))).toBe(computeAssetSemanticDigest(asset));
    expect(computeCompanionByteDigest(Buffer.from("\ufeffline\r\nπ\n"))).toBe("sha256:77110f39f0c783cca8077b62f651fd46838f3f401e28ad12d93d6f27f6a591f9");
  });
});
