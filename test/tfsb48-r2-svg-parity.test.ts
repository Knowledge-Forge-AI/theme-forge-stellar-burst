import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadProductModules } from "../tools/qualify-terminal-nova-brand.mjs";
import { CANONICAL_ASSETS, sha256Hex } from "../tools/tfsb48-r1/canonical-corpus.mjs";
import { evaluateSvgParity } from "../tools/tfsb48-r1/svg-parity.mjs";

const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

const TEST_DESTINATION = "docs/public/fixture.svg";

const TEST_ASSET = {
  ...CANONICAL_ASSETS[0],
  id: "tfsb48-r2-svg-fixture",
  filename: "fixture.svg",
  destinations: [TEST_DESTINATION],
};

const SOURCE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 16 16" role="img" aria-labelledby="title desc">
  <title id="title">TFSB48 fixture</title>
  <desc id="desc">A bounded SVG parity fixture.</desc>
  <rect x="1" y="1" width="14" height="14" rx="3" ry="3" fill="#123456"/>
</svg>
`;

/**
 * @param {string} root
 * @param {string} destination
 * @param {string} destinationText
 */
async function writeFixture(root: string, destination: string, destinationText: string) {
  await mkdir(join(root, "brand", "dist"), { recursive: true });
  await mkdir(join(root, "docs", "public"), { recursive: true });
  await writeFile(join(root, "brand", "dist", TEST_ASSET.filename), SOURCE_SVG, "utf8");
  await writeFile(join(root, destination), destinationText, "utf8");
}

/** @param {string} destinationDigest */
function provenance(sourceDigest: string, destinationDigest: string) {
  return {
    git: { commit: "a".repeat(40), tree: "b".repeat(40), clean: true },
    generatorProvenance: { path: "brand/libexec/build.py", sha256: "c".repeat(64) },
    assetMap: { [TEST_ASSET.id]: { sha256: sourceDigest } },
    trackedDestinationMap: { [TEST_DESTINATION]: { sha256: destinationDigest } },
  };
}

describe("TFSB48-R2 SVG parity and migration receipts", () => {
  it("reports exact canonical bytes as explicit P parity and binds caller provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb48-r2-svg-exact-"));
    scratchRoots.push(root);
    const product = await loadProductModules();
    const parsed = product.parseSvgV2(SOURCE_SVG, "brand/dist/fixture.svg");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("fixture parse failed");
    const serialized = product.serializeSvgV2(parsed.value, "test/tfsb48-r2-svg-fixture.toml");
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) throw new Error("fixture serialization failed");

    const sourceDigest = sha256Hex(Buffer.from(SOURCE_SVG));
    const destinationDigest = sha256Hex(Buffer.from(serialized.value));
    await writeFixture(root, TEST_DESTINATION, serialized.value);
    const result = await evaluateSvgParity(root, join(root, "run"), {
      assets: [TEST_ASSET],
      artifactPrefix: "tfsb48-r2-exact",
      corpusProvenance: provenance(sourceDigest, destinationDigest),
    });

    expect(result.summary.outcomeMCount).toBe(0);
    expect(result.summary.outcomePCount).toBe(1);
    expect(result.summary.exactParityCount).toBe(1);
    expect(result.summary.migrationRequiredCount).toBe(0);
    expect(result.summary.migrationPatchDestinationPaths).toEqual([]);
    expect(result.summary.rollbackEntryPaths).toEqual([TEST_DESTINATION]);
    expect(result.rows[0]).toMatchObject({
      disposition: "P",
      status: "qualified-exact-parity",
      bytesEqual: true,
      lexicalDiffClassification: [],
      provenance: {
        canonical: { commit: "a".repeat(40), tree: "b".repeat(40), clean: true },
        generator: { path: "brand/libexec/build.py", sha256: "c".repeat(64) },
        source: { path: "brand/dist/fixture.svg", sha256: sourceDigest },
        destination: { path: TEST_DESTINATION, sha256: destinationDigest },
      },
      rollbackReadback: { destination: TEST_DESTINATION, sha256: destinationDigest, exact: true },
    });
    expect(await readFile(result.summary.migrationPatchPath, "utf8")).toBe("");
  });

  it("creates deterministic migration and rollback artifacts only for a byte-different destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb48-r2-svg-migration-"));
    scratchRoots.push(root);
    const sourceDigest = sha256Hex(Buffer.from(SOURCE_SVG));
    const destinationDigest = sourceDigest;
    await writeFixture(root, TEST_DESTINATION, SOURCE_SVG);
    const corpusProvenance = provenance(sourceDigest, destinationDigest);

    const first = await evaluateSvgParity(root, join(root, "run-1"), {
      assets: [TEST_ASSET],
      artifactPrefix: "tfsb48-r2-migration",
      corpusProvenance,
    });
    const second = await evaluateSvgParity(root, join(root, "run-2"), {
      assets: [TEST_ASSET],
      artifactPrefix: "tfsb48-r2-migration",
      corpusProvenance,
    });
    const [firstPatch, secondPatch, firstRollback, secondRollback] = await Promise.all([
      readFile(first.summary.migrationPatchPath),
      readFile(second.summary.migrationPatchPath),
      readFile(first.summary.rollbackArchivePath),
      readFile(second.summary.rollbackArchivePath),
    ]);

    expect(first.summary.outcomeMCount).toBe(1);
    expect(first.summary.outcomePCount).toBe(0);
    expect(first.rows[0]).toMatchObject({
      disposition: "M",
      status: "qualified-normalization-migration-candidate",
      bytesEqual: false,
      structuralComparison: { match: true },
      totalChangedPixels: 0,
    });
    expect(first.rows[0].lexicalDiffClassification).toContain("byte-normalization-delta");
    expect(first.rows[0].lexicalDiffClassification).not.toContain("canonical-tag-closing");
    expect(first.summary.migrationPatchDestinationPaths).toEqual([TEST_DESTINATION]);
    expect(first.summary.rollbackEntryPaths).toEqual([TEST_DESTINATION]);
    expect(first.summary.rollbackReadback[0]).toMatchObject({ destination: TEST_DESTINATION, sha256: destinationDigest });
    expect(first.rows[0].rollbackReadback).toMatchObject({ destination: TEST_DESTINATION, sha256: destinationDigest, exact: true });
    expect(firstPatch.byteLength).toBeGreaterThan(0);
    expect(firstPatch).toEqual(secondPatch);
    expect(firstRollback).toEqual(secondRollback);
  });
});
