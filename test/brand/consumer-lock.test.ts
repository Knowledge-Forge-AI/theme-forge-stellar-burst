import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createConsumerBrandLock,
  parseConsumerBrandLock,
  serializeConsumerBrandLock,
  type ConsumerLockPackage,
} from "../../src/brand/consumer-lock.js";
import type { Sha256Digest } from "../../src/digests.js";

const d = (digit: string) => `sha256:${digit.repeat(64)}` as Sha256Digest;

function packageRecord(packageId = "terminal-nova-brand"): ConsumerLockPackage {
  return {
    packageId,
    brandVersion: "0.4.0-example.1",
    source: { kind: "local-bundle", packageId, brandVersion: "0.4.0-example.1", genericManifestByteDigest: d("1"), brandManifestDigest: d("2") },
    genericManifestByteDigest: d("1"), brandManifestDigest: d("2"), brandSystemDigest: d("3"), tokenDigest: null,
    recipeDigest: null, qaDigest: null, consumerProfileDigest: d("4"), exportDigest: null, brandPackageDigest: d("5"),
    profiles: [{ id: `${packageId}/astro-starlight`, version: 1, digest: d("6"), parameters: { theme: "light" } }],
    installed: [
      { kind: "companion", companionId: "brand-guidance", purpose: "brand-guidance", destination: "README-BRAND.md", sourceDigest: d("7"), installedDigest: d("7") },
      { kind: "asset", assetId: "favicon-on-light", family: "terminal-nova", role: "favicon", variant: "favicon-on-light", destination: "public/favicon.svg", canonicalAssetDigest: d("8"), svgDigest: d("9"), installedDigest: d("9") },
    ],
  };
}

describe("consumer lock schema 1", () => {
  it("canonicalizes, self-digests, reparses, and byte-round-trips", () => {
    const lock = createConsumerBrandLock({ schema: "tfsb.brand-lock", schemaVersion: 1, consumerProjectDigest: d("a"), packages: [packageRecord()], toolVersion: "0.3.0" });
    const bytes = serializeConsumerBrandLock(lock);
    const parsed = parseConsumerBrandLock(bytes);
    expect(parsed).toEqual({ ok: true, value: lock });
    if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
    expect(serializeConsumerBrandLock(parsed.value)).toBe(bytes);
  });

  it("rejects duplicate JSON keys before semantic validation", () => {
    const lock = createConsumerBrandLock({ schema: "tfsb.brand-lock", schemaVersion: 1, consumerProjectDigest: d("a"), packages: [], toolVersion: "0.3.0" });
    const source = serializeConsumerBrandLock(lock).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    expect(parseConsumerBrandLock(source).ok).toBe(false);
  });

  it("rejects manual edits through the self-digest", () => {
    const lock = createConsumerBrandLock({ schema: "tfsb.brand-lock", schemaVersion: 1, consumerProjectDigest: d("a"), packages: [packageRecord()], toolVersion: "0.3.0" });
    expect(parseConsumerBrandLock(serializeConsumerBrandLock(lock).replace("public/favicon.svg", "public/icon.svg")).ok).toBe(false);
  });

  it("rejects portable and ancestor destination conflicts", () => {
    const record = packageRecord();
    expect(() => createConsumerBrandLock({ schema: "tfsb.brand-lock", schemaVersion: 1, consumerProjectDigest: d("a"), packages: [{ ...record, installed: [...record.installed, { ...record.installed[1]!, destination: "public" }] }], toolVersion: "0.3.0" })).toThrow();
  });

  it("keeps the schema-1 example canonical and self-digested", () => {
    const source = readFileSync("docs/examples/v0.4/brand-system/consumer/.tfsb/brand.lock.json", "utf8");
    const parsed = parseConsumerBrandLock(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
    expect(parsed.value.lockDigest).toBe("sha256:b1081305145555d3d5cf688c681086cc63bfaa83a8375fd49039cc56a21a06aa");
    expect(serializeConsumerBrandLock(parsed.value)).toBe(source);
  });

  it("accepts 8 packages and rejects 9", () => {
    const lock = (count: number) => createConsumerBrandLock({ schema: "tfsb.brand-lock", schemaVersion: 1, consumerProjectDigest: d("a"), packages: Array.from({ length: count }, (_, index) => ({ ...packageRecord(`package-${index}`), installed: [] })), toolVersion: "0.3.0" });
    expect(parseConsumerBrandLock(serializeConsumerBrandLock(lock(8))).ok).toBe(true);
    expect(() => lock(9)).toThrow();
  });

  it("accepts 512 installed mappings and rejects 513", () => {
    const record = packageRecord();
    const lock = (count: number) => createConsumerBrandLock({ schema: "tfsb.brand-lock", schemaVersion: 1, consumerProjectDigest: d("a"), packages: [{ ...record, installed: Array.from({ length: count }, (_, index) => ({ kind: "asset" as const, assetId: "asset", destination: `out/${String(index).padStart(3, "0")}.svg`, canonicalAssetDigest: d("1"), svgDigest: d("2"), installedDigest: d("2") })) }], toolVersion: "0.3.0" });
    expect(parseConsumerBrandLock(serializeConsumerBrandLock(lock(512))).ok).toBe(true);
    expect(() => lock(513)).toThrow();
  });

  it("rejects bytes beyond the exact 1 MiB lock limit", () => {
    const oversized = `${" ".repeat(1_048_576)}x`;
    const result = parseConsumerBrandLock(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("RESOURCE_LIMIT_EXCEEDED");
  });
});
