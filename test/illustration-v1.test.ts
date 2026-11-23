import { describe, expect, it } from "vitest";

import {
  ILLUSTRATION_SCHEMA_ID,
  ILLUSTRATION_SCHEMA_VERSION,
  canonicalRasterIllustrationJson,
  computeRasterIllustrationDigest,
  createRasterIllustrationRecord,
  parseRasterIllustration,
  serializeRasterIllustration,
  validateRasterIllustrationRecord,
  type RasterIllustrationRecordWithoutDigestV1,
} from "../src/illustration/index.js";

const SHA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const PARENT = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

function input(overrides: Partial<RasterIllustrationRecordWithoutDigestV1> = {}): RasterIllustrationRecordWithoutDigestV1 {
  return {
    schema: ILLUSTRATION_SCHEMA_ID,
    schemaVersion: ILLUSTRATION_SCHEMA_VERSION,
    illustrationId: "hero-illustration",
    revision: 1,
    operation: "generate",
    characters: [{ id: "captain", revision: 2 }],
    style: { id: "stellar-burst", revision: 3 },
    provider: "openai",
    model: "image-model-1",
    source: {
      sha256: SHA,
      mime: "image/png",
      byteLength: 2048,
      dimensions: { width: 1024, height: 768 },
      alpha: "straight",
    },
    references: [{ id: "moodboard-1", sha256: SHA }],
    lineage: { parentDigest: null },
    exportRecipes: [{ id: "hero-webp", recipeSha256: SHA, mime: "image/webp", width: 1200, height: 900, alpha: "opaque" }],
    ...overrides,
  };
}

describe("raster illustration v1 source contract", () => {
  it("rejects recognizable credentials nested inside public identifiers/tokens", () => {
    const token = "sk-" + "syntheticnotasecret".repeat(2);
    expect(() => createRasterIllustrationRecord(input({ provider: `service:${token}` }))).toThrow();
    expect(() => createRasterIllustrationRecord(input({ illustrationId: `sample-${token}` }))).toThrow();
    const jwt = "eyJ" + "synthetic.header.signature";
    expect(() => createRasterIllustrationRecord(input({ model: `service:${jwt}` }))).toThrow();
  });
  it("creates a deterministic self-digested record and canonical round trip", () => {
    const record = createRasterIllustrationRecord(input());
    expect(record.digest).toBe(computeRasterIllustrationDigest(record));
    expect(validateRasterIllustrationRecord(record)).toEqual(record);
    expect(Object.isFrozen(record)).toBe(true);

    const wire = serializeRasterIllustration(record);
    expect(wire).toBe(canonicalRasterIllustrationJson(record));
    expect(parseRasterIllustration(wire)).toEqual(record);
    expect(parseRasterIllustration(wire)).toEqual(parseRasterIllustration(wire));
  });

  it("binds all metadata fields into canonical identity", () => {
    const record = createRasterIllustrationRecord(input());
    const changed = { ...record, model: "image-model-2" };
    expect(computeRasterIllustrationDigest(changed)).not.toBe(record.digest);

    const reordered = {
      exportRecipes: record.exportRecipes,
      lineage: record.lineage,
      references: record.references,
      source: record.source,
      model: record.model,
      provider: record.provider,
      style: record.style,
      characters: record.characters,
      operation: record.operation,
      revision: record.revision,
      illustrationId: record.illustrationId,
      schemaVersion: record.schemaVersion,
      schema: record.schema,
    };
    expect(computeRasterIllustrationDigest(reordered)).toBe(record.digest);
  });

  it("rejects unknown fields and does not echo private prompts or paths", () => {
    const record = createRasterIllustrationRecord(input());
    const invalid = { ...record, prompt: "private prompt /home/private-fixture" };
    let error: unknown;
    try { validateRasterIllustrationRecord(invalid); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("private prompt");
    expect(String((error as Error).message)).not.toContain("/home/private-fixture");

    const reference = { ...record, references: [{ id: "../../private", sha256: SHA }] };
    expect(() => validateRasterIllustrationRecord({ ...reference, digest: computeRasterIllustrationDigest(reference) })).toThrow();
    expect(() => createRasterIllustrationRecord(input({ provider: "sk-secret-value" }))).toThrow();
  });

  it("enforces bounded bytes and pixels without decoding image contents", () => {
    const tooLarge = input({ source: { ...input().source, byteLength: 33 * 1_048_576 } });
    expect(() => createRasterIllustrationRecord(tooLarge)).toThrow();

    const tooManyPixels = input({ source: { ...input().source, dimensions: { width: 16_384, height: 16_384 } } });
    expect(() => createRasterIllustrationRecord(tooManyPixels)).toThrow();

    const badMime = input({ source: { ...input().source, mime: "image/jpeg" as "image/png" } });
    expect(() => createRasterIllustrationRecord(badMime)).toThrow();
  });

  it("requires an edit parent and keeps generation/import provenance distinct", () => {
    const edited = createRasterIllustrationRecord(input({ operation: "edit", lineage: { parentDigest: PARENT } }));
    expect(edited.lineage.parentDigest).toBe(PARENT);
    expect(() => createRasterIllustrationRecord(input({ operation: "edit" }))).toThrow();

    const unknownImported = createRasterIllustrationRecord(input({ operation: "import", provider: null, model: null }));
    expect(unknownImported.provider).toBeNull();
    expect(unknownImported.model).toBeNull();
    const reportedImported = createRasterIllustrationRecord(input({ operation: "import", provider: "codex", model: "image-model-1" }));
    expect(reportedImported.provider).toBe("codex");
    expect(reportedImported.model).toBe("image-model-1");
  });

  it("rejects duplicate/noncanonical wire metadata and invalid lineage", () => {
    const record = createRasterIllustrationRecord(input());
    const wire = serializeRasterIllustration(record);
    expect(() => parseRasterIllustration(wire.replace("\"digest\":", "\"digest\":\"duplicate\",\n  \"digest\":"))).toThrow();
    expect(() => parseRasterIllustration(JSON.stringify(record))).toThrow(/canonical/u);
    expect(() => validateRasterIllustrationRecord({ ...record, lineage: { parentDigest: PARENT }, digest: record.digest })).toThrow();
  });

  it("rejects getters, symbols, and non-plain prototypes without invoking accessors", () => {
    const record = createRasterIllustrationRecord(input());
    let invoked = false;
    const getterRecord = { ...record };
    Object.defineProperty(getterRecord, "model", { enumerable: true, get: () => { invoked = true; return "image-model-1"; } });
    expect(() => validateRasterIllustrationRecord(getterRecord)).toThrow();
    expect(invoked).toBe(false);

    const symbolRecord = { ...record, [Symbol("private")]: true };
    expect(() => validateRasterIllustrationRecord(symbolRecord)).toThrow();

    const prototypeRecord = Object.assign(Object.create({ inherited: true }), record);
    expect(() => validateRasterIllustrationRecord(prototypeRecord)).toThrow();
  });

  it("rejects path-like and credential-like provider/model observations", () => {
    for (const token of ["file:///home/private-fixture", "Bearer-secret", "api-key-live", "sk", "token"]) {
      expect(() => createRasterIllustrationRecord(input({ model: token }))).toThrow();
    }
    expect(createRasterIllustrationRecord(input({ provider: "api-gateway" })).provider).toBe("api-gateway");
  });

  it("rejects excessive and duplicate reference collections", () => {
    const tooMany = Array.from({ length: 65 }, (_, index) => ({ id: `reference-${String(index).padStart(2, "0")}`, sha256: SHA }));
    expect(() => createRasterIllustrationRecord(input({ references: tooMany }))).toThrow();

    const duplicate = input({ references: [{ id: "moodboard-1", sha256: SHA }, { id: "moodboard-1", sha256: SHA }] });
    expect(() => createRasterIllustrationRecord(duplicate)).toThrow();
  });

  it("rejects malformed UTF-8, BOM, excessive wire depth, and unsafe integer boundaries", () => {
    const record = createRasterIllustrationRecord(input());
    const wire = serializeRasterIllustration(record);
    expect(() => parseRasterIllustration(Uint8Array.of(0xc3, 0x28))).toThrow(/UTF-8/u);
    expect(() => parseRasterIllustration(`\uFEFF${wire}`)).toThrow(/BOM/u);
    expect(() => parseRasterIllustration(Buffer.from(`\uFEFF${wire}`, "utf8"))).toThrow(/BOM/u);
    expect(() => parseRasterIllustration("[".repeat(33))).toThrow(/nesting/u);

    expect(() => createRasterIllustrationRecord(input({ revision: 0 }))).toThrow();
    expect(() => createRasterIllustrationRecord(input({ revision: -0 }))).toThrow();
    expect(() => createRasterIllustrationRecord(input({ revision: 1_000_001 }))).toThrow();
    expect(() => createRasterIllustrationRecord(input({ source: { ...input().source, byteLength: 0 } }))).toThrow();
    expect(() => createRasterIllustrationRecord(input({ source: { ...input().source, dimensions: { width: 0, height: 1 } } }))).toThrow();
    expect(() => createRasterIllustrationRecord(input({ source: { ...input().source, dimensions: { width: 16_384, height: 1_024 } } }))).not.toThrow();
    expect(() => createRasterIllustrationRecord(input({ source: { ...input().source, dimensions: { width: 16_384, height: 1_025 } } }))).toThrow();
  });

  it("rejects digest tampering while retaining the actual reported import facts", () => {
    const record = createRasterIllustrationRecord(input({ operation: "import", provider: "codex", model: "image-model-1" }));
    const tampered = { ...record, digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" };
    expect(() => validateRasterIllustrationRecord(tampered)).toThrow(/digest/u);
    expect(record.provider).toBe("codex");
    expect(record.model).toBe("image-model-1");
  });
});
