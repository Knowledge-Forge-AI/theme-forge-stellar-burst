import { describe, expect, it } from "vitest";

import { createRasterReceipt, parseRasterReceipt, rasterReceiptPath, serializeRasterReceipt } from "../../src/brand/raster-receipt.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;

function receipt() {
  return createRasterReceipt({
    adapter: { adapterId: "resvg-png-v1", companionPackage: "@knowledge-forge-ai/tfsb-raster-resvg", companionVersion: "0.0.0", backend: "wasm", rendererPackage: "@resvg/resvg-wasm", rendererVersion: "2.6.2", rendererBuildDigest: digest("1"), nodeMajor: 22, platformClaim: "darwin-arm64", qualificationId: "local-qualification" },
    source: { assetId: "logo", canonicalAssetDigest: digest("2"), svgDigest: digest("3"), brandSystemDigest: digest("4") },
    exportAuthority: { rawExportFileDigest: digest("5"), exportDomainDigest: digest("6"), profileId: "web-icons", profileDigest: digest("7"), outputId: "icon", outputConfigDigest: digest("8") },
    output: { destination: "public/icon.png", width: 192, height: 192, purpose: "pwa-icon", fit: "contain-pad", background: "transparent", colorSpace: "srgb", alpha: "straight", pngDigest: digest("9"), decodedPixelDigest: digest("a") },
    toolVersion: "0.3.0",
  });
}

describe("raster receipt schema 1", () => {
  it("serializes, parses, and verifies its self digest", () => {
    const value = receipt();
    expect(parseRasterReceipt(serializeRasterReceipt(value))).toEqual({ ok: true, value });
    expect(rasterReceiptPath("web-icons", "icon")).toBe(".tfsb/raster-receipts/web-icons/icon.receipt.json");
  });

  it.each([
    ["self digest", (text: string) => text.replace(valueDigest(), digest("b"))],
    ["adapter", (text: string) => text.replace("resvg-png-v1", "other-adapter")],
    ["source", (text: string) => text.replace('"assetId": "logo"', '"assetId": "other"')],
    ["profile", (text: string) => text.replace('"profileId": "web-icons"', '"profileId": "other"')],
    ["output", (text: string) => text.replace('"destination": "public/icon.png"', '"destination": "public/other.png"')],
  ])("rejects %s tamper", (_name, mutate) => expect(parseRasterReceipt(mutate(serializeRasterReceipt(receipt()))).ok).toBe(false));

  it("rejects duplicate JSON keys before object construction", () => {
    const text = serializeRasterReceipt(receipt()).replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,');
    expect(parseRasterReceipt(text).ok).toBe(false);
  });
});

function valueDigest(): string { return receipt().evidence.receiptDigest; }

