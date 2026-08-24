import { describe, expect, it } from "vitest";

import {
  ARCHIVE_DIGEST_BASIS,
  ARCHIVE_SOURCE_DIGEST_BASIS,
  ASSET_DIGEST_BASIS,
  ASSET_DIGEST_BASIS_V2,
  MIGRATION_RESOLUTION,
  SVG_OUTPUT_DIGEST_BASIS,
  createNormalizationPolicyIdentity,
  parseImportProvenanceV2,
  serializeImportProvenanceV2,
  type AssetProvenanceRecordV2,
  type ImportProvenanceV2,
} from "../src/index.js";
import { unwrap } from "./helpers.js";

const A = `sha256:${"a".repeat(64)}` as const;
const B = `sha256:${"b".repeat(64)}` as const;
const C = `sha256:${"c".repeat(64)}` as const;
const S = `sha256:${"d".repeat(64)}` as const;

function asset(assetId: string, archive: AssetProvenanceRecordV2["archive"]): AssetProvenanceRecordV2 {
  return {
    type: "asset",
    assetId,
    canonicalPath: `.tfsb/assets/${assetId}.toml`,
    archive,
    migration: {
      fromSchemaVersion: 1,
      toSchemaVersion: 2,
      beforeBasis: ASSET_DIGEST_BASIS,
      beforeDigest: B,
      afterBasis: ASSET_DIGEST_BASIS_V2,
      afterDigest: C,
      svgBasis: SVG_OUTPUT_DIGEST_BASIS,
      beforeSvgDigest: S,
      afterSvgDigest: S,
      svgEquivalent: true,
      resolution: MIGRATION_RESOLUTION,
      toolVersion: "0.2.0",
    },
    normalizationPolicy: null,
  };
}

describe("provenance schema 2", () => {
  it("round-trips absent and partial archive observations without inventing them", () => {
    const trackedArchive = {
      archiveDigestBasis: ARCHIVE_DIGEST_BASIS,
      archiveDigest: A,
      entryName: "icons/tracked.svg",
      sourceBasis: ARCHIVE_SOURCE_DIGEST_BASIS,
      sourceDigest: A,
      archiveCanonicalBasis: ASSET_DIGEST_BASIS,
      archiveCanonicalDigest: B,
      canonicalBasis: ASSET_DIGEST_BASIS,
      canonicalState: "present" as const,
      canonicalDigest: B,
      resolution: "aligned" as const,
      toolVersion: "0.2.0",
    };
    const provenance: ImportProvenanceV2 = {
      kind: "tfsb-import-provenance",
      schemaVersion: 2,
      records: [asset("untracked", null), asset("tracked", trackedArchive)],
    };
    const serialized = serializeImportProvenanceV2(provenance);
    const parsed = unwrap(parseImportProvenanceV2(serialized));
    expect(parsed.records.map((record) => record.type === "asset" ? [record.assetId, record.archive] : [])).toEqual([
      ["tracked", trackedArchive],
      ["untracked", null],
    ]);
    expect(serializeImportProvenanceV2(parsed)).toBe(serialized);
  });

  it("stores the complete normalization policy identity and rejects forged policy digests", () => {
    const policy = createNormalizationPolicyIdentity();
    const provenance: ImportProvenanceV2 = { kind: "tfsb-import-provenance", schemaVersion: 2, records: [{ ...asset("normalized", null), migration: null, normalizationPolicy: policy }] };
    expect(unwrap(parseImportProvenanceV2(serializeImportProvenanceV2(provenance))).records[0]).toMatchObject({ normalizationPolicy: policy });
    const forged = JSON.parse(serializeImportProvenanceV2(provenance)) as { records: { normalizationPolicy: { policyDigest: string } }[] };
    forged.records[0]!.normalizationPolicy.policyDigest = A;
    expect(parseImportProvenanceV2(JSON.stringify(forged)).ok).toBe(false);
  });

  it("rejects unknown fields, invalid bases, impossible migration equality, and malformed digests", () => {
    const base = JSON.parse(serializeImportProvenanceV2({ kind: "tfsb-import-provenance", schemaVersion: 2, records: [asset("seed", null)] })) as any;
    base.records[0].unknown = true;
    expect(parseImportProvenanceV2(JSON.stringify(base)).ok).toBe(false);
    delete base.records[0].unknown;
    base.records[0].migration.afterBasis = "tfsb-asset-toml-v1";
    expect(parseImportProvenanceV2(JSON.stringify(base)).ok).toBe(false);
    base.records[0].migration.afterBasis = ASSET_DIGEST_BASIS_V2;
    base.records[0].migration.afterSvgDigest = A;
    expect(parseImportProvenanceV2(JSON.stringify(base)).ok).toBe(false);
    base.records[0].migration.afterSvgDigest = "sha256:nope";
    expect(parseImportProvenanceV2(JSON.stringify(base)).ok).toBe(false);
  });
});
