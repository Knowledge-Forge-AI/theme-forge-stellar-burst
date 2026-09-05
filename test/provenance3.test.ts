import { describe, expect, it } from "vitest";

import {
  ARCHIVE_DIGEST_BASIS,
  ARCHIVE_SOURCE_DIGEST_BASIS,
  ASSET_DIGEST_BASIS,
  ASSET_DIGEST_BASIS_V2,
  COMPANION_DIGEST_BASIS,
  DIRECTORY_FILE_BYTES_BASIS,
  DIRECTORY_SNAPSHOT_BASIS,
  MIGRATION_RESOLUTION,
  PROVENANCE_SCHEMA_VERSION_V3,
  SOURCE_MAP_DIGEST_BASIS,
  SVG_OUTPUT_DIGEST_BASIS,
  createNormalizationPolicyIdentity,
  parseImportProvenanceV2,
  parseImportProvenanceV3,
  serializeImportProvenanceV2,
  serializeImportProvenanceV3,
  type ArchiveCheckpointV2,
  type ArchiveSourceCheckpointV3,
  type DirectorySourceCheckpointV3,
  type ImportProvenanceV2,
  type ImportProvenanceV3,
  type MigrationEvidenceV2,
} from "../src/index.js";
import { liftImportProvenanceV2ToV3 } from "../src/provenance3.js";
import { unwrap } from "./helpers.js";

const A = `sha256:${"a".repeat(64)}` as const;
const B = `sha256:${"b".repeat(64)}` as const;
const C = `sha256:${"c".repeat(64)}` as const;

function archiveCheckpoint(
  basis: typeof ASSET_DIGEST_BASIS | typeof ASSET_DIGEST_BASIS_V2 | typeof COMPANION_DIGEST_BASIS,
  entryName: string,
  canonicalState: "present" | "absent" = "present",
): ArchiveCheckpointV2 {
  return {
    archiveDigestBasis: ARCHIVE_DIGEST_BASIS,
    archiveDigest: A,
    entryName,
    sourceBasis: ARCHIVE_SOURCE_DIGEST_BASIS,
    sourceDigest: B,
    archiveCanonicalBasis: basis,
    archiveCanonicalDigest: C,
    canonicalBasis: basis,
    canonicalState,
    canonicalDigest: canonicalState === "present" ? C : null,
    resolution: canonicalState === "present" ? "aligned" : "canonical",
    toolVersion: "0.3.0",
  };
}

function archiveSource(basis: typeof ASSET_DIGEST_BASIS | typeof ASSET_DIGEST_BASIS_V2 | typeof COMPANION_DIGEST_BASIS): ArchiveSourceCheckpointV3 {
  return { kind: "archive", ...archiveCheckpoint(basis, basis === COMPANION_DIGEST_BASIS ? "README.md" : "icons/a.svg") };
}

function migrationEvidence(): MigrationEvidenceV2 {
  return {
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    beforeBasis: ASSET_DIGEST_BASIS,
    beforeDigest: B,
    afterBasis: ASSET_DIGEST_BASIS_V2,
    afterDigest: C,
    svgBasis: SVG_OUTPUT_DIGEST_BASIS,
    beforeSvgDigest: A,
    afterSvgDigest: A,
    svgEquivalent: true,
    resolution: MIGRATION_RESOLUTION,
    toolVersion: "0.3.0",
  };
}

function directorySource(basis: typeof ASSET_DIGEST_BASIS_V2 | typeof COMPANION_DIGEST_BASIS, sourcePath = "icons/a.svg"): DirectorySourceCheckpointV3 {
  return {
    kind: "directory",
    collectionId: "icons",
    sourcePath,
    sourceMapBasis: SOURCE_MAP_DIGEST_BASIS,
    sourceMapDigest: A,
    snapshotBasis: DIRECTORY_SNAPSHOT_BASIS,
    snapshotDigest: B,
    sourceBasis: DIRECTORY_FILE_BYTES_BASIS,
    sourceState: "present",
    sourceDigest: C,
    sourceCanonicalBasis: basis,
    sourceCanonicalDigest: A,
    canonicalBasis: basis,
    canonicalState: "present",
    canonicalDigest: A,
    resolution: "aligned",
    toolVersion: "0.3.0",
  };
}

function document(): ImportProvenanceV3 {
  return {
    kind: "tfsb-import-provenance",
    schemaVersion: PROVENANCE_SCHEMA_VERSION_V3,
    records: [
      { type: "companion", canonicalPath: ".tfsb/companions/README.md", source: directorySource(COMPANION_DIGEST_BASIS, "README.md") },
      { type: "asset", assetId: "zeta", canonicalPath: ".tfsb/assets/zeta.toml", source: archiveSource(ASSET_DIGEST_BASIS), migration: null, normalizationPolicy: null },
      { type: "asset", assetId: "alpha", canonicalPath: ".tfsb/assets/alpha.toml", source: directorySource(ASSET_DIGEST_BASIS_V2), migration: null, normalizationPolicy: createNormalizationPolicyIdentity() },
      { type: "asset", assetId: "untracked", canonicalPath: ".tfsb/assets/untracked.toml", source: null, migration: null, normalizationPolicy: null },
      { type: "companion", canonicalPath: ".tfsb/companions/NOTICE", source: archiveSource(COMPANION_DIGEST_BASIS) },
    ],
  };
}

function v2Document(): ImportProvenanceV2 {
  return {
    kind: "tfsb-import-provenance",
    schemaVersion: 2,
    records: [
      { type: "companion", canonicalPath: ".tfsb/companions/z-notice", archive: archiveCheckpoint(COMPANION_DIGEST_BASIS, "NOTICE") },
      { type: "asset", assetId: "zeta", canonicalPath: ".tfsb/assets/zeta.toml", archive: archiveCheckpoint(ASSET_DIGEST_BASIS, "legacy.svg"), migration: migrationEvidence(), normalizationPolicy: createNormalizationPolicyIdentity() },
      { type: "asset", assetId: "untracked", canonicalPath: ".tfsb/assets/untracked.toml", archive: null, migration: null, normalizationPolicy: null },
      { type: "asset", assetId: "alpha", canonicalPath: ".tfsb/assets/alpha.toml", archive: archiveCheckpoint(ASSET_DIGEST_BASIS_V2, "icons/alpha.svg", "absent"), migration: null, normalizationPolicy: null },
      { type: "companion", canonicalPath: ".tfsb/companions/README.md", archive: archiveCheckpoint(COMPANION_DIGEST_BASIS, "README.md") },
    ],
  };
}

function assetRecord(value: ImportProvenanceV2, assetId: string): Extract<ImportProvenanceV2["records"][number], { type: "asset" }> {
  const record = value.records.find((candidate) => candidate.type === "asset" && candidate.assetId === assetId);
  if (record?.type !== "asset") throw new Error(`Missing asset fixture '${assetId}'.`);
  return record;
}

function companionRecord(value: ImportProvenanceV2, canonicalPath: string): Extract<ImportProvenanceV2["records"][number], { type: "companion" }> {
  const record = value.records.find((candidate) => candidate.type === "companion" && candidate.canonicalPath === canonicalPath);
  if (record?.type !== "companion") throw new Error(`Missing companion fixture '${canonicalPath}'.`);
  return record;
}

describe("provenance schema 3", () => {
  it("round-trips directory and archive asset/companion sources with deterministic ordering", () => {
    const serialized = serializeImportProvenanceV3(document());
    const parsed = unwrap(parseImportProvenanceV3(serialized));
    expect(parsed.records.map((record) => record.type === "asset" ? `asset:${record.assetId}` : `companion:${record.canonicalPath}`)).toEqual([
      "asset:alpha",
      "asset:untracked",
      "asset:zeta",
      "companion:.tfsb/companions/NOTICE",
      "companion:.tfsb/companions/README.md",
    ]);
    expect(parsed.records[0]).toMatchObject({ source: { kind: "directory", toolVersion: "0.3.0" }, normalizationPolicy: { implementationVersion: "0.4.0" } });
    expect(serializeImportProvenanceV3(parsed)).toBe(serialized);
  });

  it("keeps valid lifted schema-1 archive bases and nullable asset sources representable", () => {
    const parsed = unwrap(parseImportProvenanceV3(serializeImportProvenanceV3(document())));
    expect(parsed.records.find((record) => record.type === "asset" && record.assetId === "zeta")).toMatchObject({ source: { kind: "archive", canonicalBasis: ASSET_DIGEST_BASIS } });
    expect(parsed.records.find((record) => record.type === "asset" && record.assetId === "untracked")).toMatchObject({ source: null });
  });

  it("rejects unknown and missing fields at every new schema level", () => {
    const base = JSON.parse(serializeImportProvenanceV3(document())) as any;
    for (const mutate of [
      (value: any) => { value.unknown = true; },
      (value: any) => { delete value.records; },
      (value: any) => { value.records[0].unknown = true; },
      (value: any) => { delete value.records[0].source; },
      (value: any) => { value.records[0].source.unknown = true; },
      (value: any) => { delete value.records[0].source.sourceMapDigest; },
    ]) {
      const value = structuredClone(base); mutate(value);
      expect(parseImportProvenanceV3(JSON.stringify(value)).ok).toBe(false);
    }
  });

  it.each([
    ["collectionId", "Bad Id"],
    ["sourcePath", "../escape.svg"],
    ["sourceMapBasis", "unknown"],
    ["sourceMapDigest", "sha256:nope"],
    ["snapshotBasis", "unknown"],
    ["snapshotDigest", "sha256:nope"],
    ["sourceBasis", "unknown"],
    ["sourceState", "absent"],
    ["canonicalState", "absent"],
    ["resolution", "canonical"],
  ])("rejects an inconsistent directory %s mutation", (field, value) => {
    const documentValue = JSON.parse(serializeImportProvenanceV3(document())) as any;
    const source = documentValue.records.find((record: any) => record.type === "asset" && record.source?.kind === "directory").source;
    source[field] = value;
    expect(parseImportProvenanceV3(JSON.stringify(documentValue)).ok).toBe(false);
  });

  it("rejects directory record basis mismatches, unknown source kinds, duplicate identities, and false canonical divergence", () => {
    const base = JSON.parse(serializeImportProvenanceV3(document())) as any;
    const directory = base.records.find((record: any) => record.type === "asset" && record.source?.kind === "directory");
    for (const mutate of [
      (value: any) => { value.source.sourceCanonicalBasis = COMPANION_DIGEST_BASIS; value.source.canonicalBasis = COMPANION_DIGEST_BASIS; },
      (value: any) => { value.source.kind = "workspace"; },
      (value: any) => { value.source.resolution = "canonical"; },
    ]) {
      const value = structuredClone(directory); mutate(value);
      const doc = structuredClone(base); doc.records = [value];
      expect(parseImportProvenanceV3(JSON.stringify(doc)).ok).toBe(false);
    }
    const duplicate = structuredClone(base); duplicate.records.push(structuredClone(duplicate.records[0]));
    expect(parseImportProvenanceV3(JSON.stringify(duplicate)).ok).toBe(false);
  });

  it("does not change schema-2 parser/writer bytes", () => {
    const v2: ImportProvenanceV2 = {
      kind: "tfsb-import-provenance",
      schemaVersion: 2,
      records: [{ type: "asset", assetId: "a", canonicalPath: ".tfsb/assets/a.toml", archive: null, migration: null, normalizationPolicy: null }],
    };
    expect(serializeImportProvenanceV2(v2)).toBe('{\n  "kind": "tfsb-import-provenance",\n  "schemaVersion": 2,\n  "records": [\n    {\n      "type": "asset",\n      "assetId": "a",\n      "canonicalPath": ".tfsb/assets/a.toml",\n      "archive": null,\n      "migration": null,\n      "normalizationPolicy": null\n    }\n  ]\n}\n');
  });

  it("explicitly lifts every schema-2 source and preserves exact history, fields, and v3 ordering", () => {
    const v2 = v2Document();
    const before = structuredClone(v2);
    const lifted = liftImportProvenanceV2ToV3(v2);

    expect(v2).toEqual(before);
    expect(lifted.records.map((record) => record.type === "asset" ? `asset:${record.assetId}` : `companion:${record.canonicalPath}`)).toEqual([
      "asset:alpha",
      "asset:untracked",
      "asset:zeta",
      "companion:.tfsb/companions/README.md",
      "companion:.tfsb/companions/z-notice",
    ]);

    const zetaV2 = assetRecord(v2, "zeta");
    if (zetaV2.archive === null) throw new Error("Expected a schema-1 archive fixture.");
    const zetaV3 = lifted.records.find((record) => record.type === "asset" && record.assetId === "zeta");
    expect(zetaV3).toMatchObject({ migration: zetaV2.migration, normalizationPolicy: zetaV2.normalizationPolicy });
    expect(zetaV3?.type === "asset" ? zetaV3.source : undefined).toEqual({ kind: "archive", ...zetaV2.archive });
    expect(zetaV3?.type === "asset" && zetaV3.source?.kind === "archive" ? zetaV3.source.canonicalBasis : undefined).toBe(ASSET_DIGEST_BASIS);

    const alphaV2 = assetRecord(v2, "alpha");
    if (alphaV2.archive === null) throw new Error("Expected an archive fixture.");
    const alphaV3 = lifted.records.find((record) => record.type === "asset" && record.assetId === "alpha");
    expect(alphaV3?.type === "asset" ? alphaV3.source : undefined).toEqual({ kind: "archive", ...alphaV2.archive });
    expect(alphaV3?.type === "asset" && alphaV3.source?.kind === "archive" ? alphaV3.source.canonicalState : undefined).toBe("absent");

    const untrackedV3 = lifted.records.find((record) => record.type === "asset" && record.assetId === "untracked");
    expect(untrackedV3?.type === "asset" ? untrackedV3.source : undefined).toBeNull();

    const readmeV2 = companionRecord(v2, ".tfsb/companions/README.md");
    const readmeV3 = lifted.records.find((record) => record.type === "companion" && record.canonicalPath === readmeV2.canonicalPath);
    expect(readmeV3?.type === "companion" ? readmeV3.source : undefined).toEqual({ kind: "archive", ...readmeV2.archive });

    const serialized = serializeImportProvenanceV3(lifted);
    expect(unwrap(parseImportProvenanceV3(serialized))).toEqual(lifted);
    expect(serializeImportProvenanceV3(liftImportProvenanceV2ToV3({ ...v2, records: [...v2.records].reverse() }))).toBe(serialized);
  });

  it("keeps schema-version parsers explicit instead of silently lifting schema 2", () => {
    const v2 = v2Document();
    const bytes = serializeImportProvenanceV2(v2);
    expect(parseImportProvenanceV2(bytes).ok).toBe(true);
    expect(parseImportProvenanceV3(bytes).ok).toBe(false);
  });
});
