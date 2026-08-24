import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { classifySvg, PROJECTION_STAGES } from "../tools/project-v0.3-compatibility.mjs";
import { parseSvg, serializeSvg } from "../src/svg.js";
import { unwrap } from "./helpers.js";

const rejectedSchema1 = () => ({ ok: false as const, diagnostics: [] });
const acceptedSchema1 = () => ({ ok: true as const, value: {} });

describe("v0.3 compatibility projection", () => {
  it("keeps current schema-1 compatibility distinct from title-only normalization", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img"><title>Brand</title><path d="M0 0h24v24z"/></svg>';
    const record = classifySvg(source, rejectedSchema1);

    expect(record.schema1Compatible).toBe(false);
    expect(record.minimumStage).toBe(2);
    expect([...record.normalizations]).toContain("title_only_to_labelled");
    expect(record.unsupported.size).toBe(0);
    expect(record.unsafe.size).toBe(0);
  });

  it("requires the cumulative root-presentation, geometry, and rotate stages", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="4" transform="rotate(45 12 12)"/></svg>';
    const record = classifySvg(source, rejectedSchema1);

    expect(record.minimumStage).toBe(5);
    expect([...record.requiredFeatures]).toEqual(expect.arrayContaining([
      "root-presentation.fill",
      "paint.currentColor",
      "element.circle",
      "transform.rotate",
    ]));
    expect([...record.normalizations]).toEqual(expect.arrayContaining([
      "accessibility_authority_required",
      "promote_root_presentation",
    ]));
  });

  it("rejects active content and external references before normalization", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><image href="https://example.invalid/a.png"/><path onclick="run()" d="M0 0"/></svg>';
    const record = classifySvg(source, rejectedSchema1);

    expect([...record.unsafe]).toEqual(expect.arrayContaining([
      "SVG_ACTIVE_ELEMENT",
      "SVG_EXTERNAL_REFERENCE",
      "SVG_ACTIVE_ATTRIBUTE",
    ]));
  });

  it("keeps matrix and symbol outside the proposed profile", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><symbol id="x"><path d="M0 0"/></symbol><path transform="matrix(1 0 0 1 0 0)" d="M0 0"/></svg>';
    const record = classifySvg(source, rejectedSchema1);

    expect([...record.unsupported]).toEqual(expect.arrayContaining([
      "SVG_UNSUPPORTED_ELEMENT",
      "SVG_UNSUPPORTED_TRANSFORM",
    ]));
  });

  it("retains a frozen schema-1 success", () => {
    const record = classifySvg('<svg xmlns="http://www.w3.org/2000/svg"/>', acceptedSchema1);
    expect(record.schema1Compatible).toBe(true);
    expect(PROJECTION_STAGES).toHaveLength(6);
  });

  it("accepts SVG version 1.0 as an explicit canonicalization", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" version="1.0" viewBox="0 0 24 24" role="img"><title>Brand</title><path d="M0 0h24v24z"/></svg>';
    const record = classifySvg(source, rejectedSchema1);

    expect([...record.unsupported]).not.toContain("SVG_UNSUPPORTED_VERSION");
    expect([...record.normalizations]).toContain("canonicalize_svg_version");
  });

  it("keeps the committed full-corpus projection complete and privacy bounded", async () => {
    const raw = await readFile("docs/evaluations/v0.3-compatibility-projection.json", "utf8");
    const { stableJson } = await import("../tools/audit-dogfood-corpus.mjs");
    const projection = JSON.parse(raw) as {
      profile: string;
      authority: {
        counts: string;
        authoritativeProducer: string;
        constraintsNotEvaluated: string[];
      };
      corpora: Array<{
        id: string;
        source: { svgCount: number };
        stages: Array<{
          id: string;
          directlyImportable: number;
          importableWithNormalization: number;
          unsupported: number;
          unsafe: number;
        }>;
      }>;
    };

    expect(projection.profile).toBe("tfsb-svg-common-v0.3");
    expect(projection.authority.counts).toBe("provisional_projection_bounds");
    expect(projection.authority.authoritativeProducer).toBe("tfsb-analyze-v1");
    expect(projection.authority.constraintsNotEvaluated).toEqual(expect.arrayContaining([
      "complete_path_data_grammar",
      "definition_authority_and_reference_cycles",
      "profile_group_depth_and_modeled_element_bounds",
    ]));
    for (const corpus of projection.corpora) {
      for (const stage of corpus.stages) {
        expect(
          stage.directlyImportable +
            stage.importableWithNormalization +
            stage.unsupported +
            stage.unsafe,
        ).toBe(corpus.source.svgCount);
      }
    }
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain("M12 2L22");
    expect(stableJson(projection)).toBe(raw);
    const report = await readFile("docs/evaluations/v0.3-compatibility-projection.md", "utf8");
    expect(report).toContain(createHash("sha256").update(raw).digest("hex"));
  });

  it("freezes the authoritative two-profile dogfood baseline without rewriting the projection", async () => {
    const raw = await readFile("docs/evaluations/v0.3-analyzer-dogfood-baseline.json", "utf8");
    const { stableJson } = await import("../tools/audit-dogfood-corpus.mjs");
    const baseline = JSON.parse(raw) as {
      schema: string;
      schemaVersion: number;
      kind: string;
      product: { packageVersion: string; profiles: { schema1: string; commonV03: string } };
      verification: Record<string, boolean | number>;
      corpora: Array<{
        id: string;
        trackedTree: { nonRegularEntries: Array<{ mode: string; path: string }> };
        sourceSafety: {
          directory: { acceptedAsAnalyzableSource: boolean; scanAbortingDiagnostics: string[] };
          zip: { disposition: string };
        };
        regularSvgCorpus: { regularSvgPaths: number; manifestSha256: string };
        analyzerMeasurement: {
          aggregateJsonByteIdentical: boolean;
          detailNdjsonByteIdentical: boolean;
          profileArithmeticValid: boolean;
          sensitiveLeakageMatches: string[];
          profiles: {
            schema1: { profile: string; counts: Record<string, number> };
            commonV03: { profile: string; counts: Record<string, number> };
          };
        };
        provisionalComparison: {
          projectionRevisionMatches: boolean;
          commonV03: {
            authoritative: Record<string, number>;
            delta: Record<string, number>;
          };
        };
      }>;
    };

    expect(baseline).toMatchObject({
      schema: "tfsb-v0.3-analyzer-dogfood-baseline",
      schemaVersion: 1,
      kind: "authoritative_analyzer_dogfood_evidence",
      product: {
        packageVersion: "0.2.0",
        profiles: { schema1: "tfsb-svg-schema-1", commonV03: "tfsb-svg-common-v0.3" },
      },
      verification: {
        independentRuns: 2,
        allAggregateJsonByteIdentical: true,
        allDetailNdjsonByteIdentical: true,
        allProfileArithmeticValid: true,
        allLeakageScansClear: true,
        allRegularSourceEquivalenceChecksPass: true,
      },
    });
    expect(baseline.corpora.map((corpus) => corpus.id)).toEqual([
      "lucide",
      "simple-icons",
      "tabler-icons",
      "thesvg",
    ]);

    const expectedCommonV03 = {
      lucide: { directlyImportable: 0, importableWithNormalization: 2147, unsupported: 89, unsafe: 20 },
      "simple-icons": { directlyImportable: 0, importableWithNormalization: 3453, unsupported: 0, unsafe: 0 },
      "tabler-icons": { directlyImportable: 0, importableWithNormalization: 6184, unsupported: 1, unsafe: 225 },
      thesvg: { directlyImportable: 2, importableWithNormalization: 8022, unsupported: 3644, unsafe: 789 },
    } as const;
    for (const corpus of baseline.corpora) {
      expect(corpus.analyzerMeasurement.profiles.schema1.profile).toBe("tfsb-svg-schema-1");
      expect(corpus.analyzerMeasurement.profiles.commonV03.profile).toBe("tfsb-svg-common-v0.3");
      expect(corpus.analyzerMeasurement.profiles.commonV03.counts).toEqual(
        expectedCommonV03[corpus.id as keyof typeof expectedCommonV03],
      );
      for (const profile of Object.values(corpus.analyzerMeasurement.profiles)) {
        expect(Object.values(profile.counts).reduce((sum, value) => sum + value, 0)).toBe(
          corpus.regularSvgCorpus.regularSvgPaths,
        );
      }
      expect(corpus.regularSvgCorpus.manifestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(corpus.analyzerMeasurement).toMatchObject({
        aggregateJsonByteIdentical: true,
        detailNdjsonByteIdentical: true,
        profileArithmeticValid: true,
        sensitiveLeakageMatches: [],
      });
      expect(corpus.provisionalComparison.projectionRevisionMatches).toBe(true);
    }

    const simpleIcons = baseline.corpora.find((corpus) => corpus.id === "simple-icons");
    expect(simpleIcons).toBeDefined();
    expect(simpleIcons?.sourceSafety.directory).toEqual(expect.objectContaining({
      acceptedAsAnalyzableSource: false,
      scanAbortingDiagnostics: ["ANALYZE_SNAPSHOT_FAILED"],
    }));
    expect(simpleIcons?.sourceSafety.zip.disposition).toBe("not_run_non_regular_tracked_entry");
    expect(simpleIcons?.trackedTree.nonRegularEntries).toEqual([
      expect.objectContaining({ mode: "120000", path: ".nvmrc" }),
    ]);

    const thesvg = baseline.corpora.find((corpus) => corpus.id === "thesvg");
    expect(thesvg?.provisionalComparison.commonV03.delta).toEqual({
      directlyImportable: 2,
      importableWithNormalization: -9,
      unsupported: 10,
      unsafe: -3,
    });
    expect(thesvg?.provisionalComparison.commonV03.authoritative).toEqual(expectedCommonV03.thesvg);

    expect(stableJson(baseline)).toBe(raw);
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain("<svg");
    expect(raw).not.toContain("TFSB_SECRET_TITLE_91d2");
    expect(raw).not.toContain("M91.123 82.456L73.789 64.321");
    const report = await readFile("docs/evaluations/v0.3-analyzer-dogfood-baseline.md", "utf8");
    expect(report).toContain(createHash("sha256").update(raw).digest("hex"));
  });

  it("verifies the migrated Terminal Nova example matches fresh schema-1 canonical SVG serialization", async () => {
    const sourceFixture = await readFile("test/fixtures/tftn-production-v1/favicon-on-dark.svg", "utf8");
    const exampleSvg = await readFile("docs/examples/v0.3/migrated-terminal-nova.svg", "utf8");

    const parsed = parseSvg(sourceFixture, "favicon-on-dark.svg");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const serialized = serializeSvg(parsed.value);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    expect(exampleSvg).toBe(serialized.value);
  });

  it("freezes schema-1 use, group, root, and definition ordering in a synthetic golden", async () => {
    const source = await readFile("docs/examples/v0.3/schema-1-ordering-source.svg", "utf8");
    const golden = await readFile("docs/examples/v0.3/schema-1-ordering-golden.svg", "utf8");
    const serialized = unwrap(serializeSvg(unwrap(parseSvg(source, "schema-1-ordering-source.svg"))));

    expect(serialized).toBe(golden);
    expect(serialized.indexOf('id="z-gradient"')).toBeLessThan(serialized.indexOf('id="a-gradient"'));
    expect(serialized.indexOf('id="z-group"')).toBeLessThan(serialized.indexOf('id="a-group"'));
    expect(serialized.indexOf('id="z-path"')).toBeLessThan(serialized.indexOf('id="a-path"'));
    expect(serialized).toContain('<use id="instance" href="#z-path" x="2" y="3" fill="#555555" stroke="#666666" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel" stroke-miterlimit="5" opacity="0.75" aria-hidden="false" transform="translate(1 2) scale(0.5)"/>');
    expect(serialized).toContain('<g id="artwork" fill="#333333" stroke="#444444" opacity="0.5" transform="translate(1 2)">');
    expect(serialized).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" role="img" aria-labelledby="title description" focusable="false" shape-rendering="crispEdges">');
  });

  it("freezes every combination of schema-1 optional root attributes", async () => {
    const source = await readFile("docs/examples/v0.3/schema-1-ordering-source.svg", "utf8");
    const base = unwrap(parseSvg(source, "schema-1-ordering-source.svg"));

    for (let mask = 0; mask < 16; mask += 1) {
      const serialized = unwrap(serializeSvg({
        ...base,
        canvas: {
          viewBox: base.canvas.viewBox,
          ...(mask & 1 ? { width: 24 } : {}),
          ...(mask & 2 ? { height: 24 } : {}),
          ...(mask & 4 ? { shapeRendering: "crispEdges" as const } : {}),
        },
        accessibility: {
          title: base.accessibility.title,
          titleId: base.accessibility.titleId,
          description: base.accessibility.description,
          descriptionId: base.accessibility.descriptionId,
          ...(mask & 8 ? { focusable: false } : {}),
        },
      }));
      const root = serialized.split("\n")[1] ?? "";
      const attributes = [
        'xmlns="http://www.w3.org/2000/svg"',
        ...(mask & 1 ? ['width="24"'] : []),
        ...(mask & 2 ? ['height="24"'] : []),
        'viewBox="0 0 24 24"',
        'role="img"',
        'aria-labelledby="title description"',
        ...(mask & 8 ? ['focusable="false"'] : []),
        ...(mask & 4 ? ['shape-rendering="crispEdges"'] : []),
      ];
      const positions = attributes.map((attribute) => root.indexOf(attribute));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    }
  });

  it("verifies the unsupported clipping analyze JSON example has a valid target-profile envelope", async () => {
    const raw = await readFile("docs/examples/v0.3/unsupported-clipping.analyze.json", "utf8");
    const json = JSON.parse(raw);

    expect(json.schemaVersion).toBe(1);
    expect(json.command).toBe("analyze");
    expect(json.status).toBe("drift");
    expect(json.exitCode).toBe(2);
    expect(json.data.scanCompleted).toBe(true);
    expect(json.data.profiles.schema1.profile).toBe("tfsb-svg-schema-1");
    expect(json.data.profiles.commonV03.profile).toBe("tfsb-svg-common-v0.3");
    expect(json.data.profiles.commonV03.counts).toEqual({
      directlyImportable: 0,
      importableWithNormalization: 0,
      unsupported: 1,
      unsafe: 0,
    });
    expect(json.diagnostics).toHaveLength(3);
    const diag = json.diagnostics.find((entry: { code: string }) => entry.code === "ANALYZE_UNSUPPORTED_ELEMENT");
    expect(diag).toHaveProperty("code", "ANALYZE_UNSUPPORTED_ELEMENT");
    expect(diag).toHaveProperty("severity", "error");
    expect(diag).toHaveProperty("operation", "analyze");
    expect(diag).toHaveProperty("domain", "svg");
    expect(diag).toHaveProperty("modelLocation", "/svg/defs/clipPath");
    expect(diag).not.toHaveProperty("path");
    expect(diag).not.toHaveProperty("feature");
  });

  it("keeps the two-profile detail example consistent with the aggregate DTO", async () => {
    const aggregate = JSON.parse(await readFile("docs/examples/v0.3/unsupported-clipping.analyze.json", "utf8"));
    const raw = await readFile("docs/examples/v0.3/unsupported-clipping.analyze.ndjson", "utf8");
    const lines = raw.trimEnd().split("\n");
    const [header, file, footer] = lines.map((line) => JSON.parse(line));

    expect(header).toMatchObject({
      recordType: "header",
      schema: "tfsb-analyze-details",
      schemaVersion: 1,
      profiles: {
        schema1: "tfsb-svg-schema-1",
        commonV03: "tfsb-svg-common-v0.3",
      },
    });
    expect(file.profiles.schema1.profile).toBe(header.profiles.schema1);
    expect(file.profiles.commonV03.profile).toBe(header.profiles.commonV03);
    expect(file.profiles.schema1.classification).toBe("unsupported");
    expect(file.profiles.commonV03.classification).toBe("unsupported");
    expect(footer.profiles).toEqual({
      schema1: aggregate.data.profiles.schema1.counts,
      commonV03: aggregate.data.profiles.commonV03.counts,
    });
    expect(footer.recordsSha256).toBe(
      `sha256:${createHash("sha256").update(`${lines[0]}\n${lines[1]}\n`).digest("hex")}`,
    );
  });

  it("closes analyze envelope, diagnostic, and normalization vocabularies", async () => {
    const contract = JSON.parse(await readFile("docs/evaluations/v0.3-analyze-contract.json", "utf8"));
    expect(contract.schema).toBe("tfsb-v0.3-analyze-contract");
    expect(contract.schemaVersion).toBe(1);
    expect(contract.profiles.schema1.profile).toBe("tfsb-svg-schema-1");
    expect(contract.profiles.commonV03.profile).toBe("tfsb-svg-common-v0.3");
    expect(contract.envelopeCases).toEqual([
      { case: "complete_direct", status: "ok", exitCode: 0, data: "complete", scanCompleted: true },
      { case: "complete_drift", status: "drift", exitCode: 2, data: "complete", scanCompleted: true },
      { case: "complete_unsafe", status: "error", exitCode: 1, data: "complete", scanCompleted: true },
      { case: "incomplete_scan", status: "error", exitCode: 1, data: "null", scanCompleted: null },
    ]);

    const diagnostics = new Map<string, { data: string; classification: string | null }>(
      contract.diagnostics.map((entry: { code: string; data: string; classification: string | null }) => [entry.code, entry]),
    );
    expect(diagnostics.size).toBe(contract.diagnostics.length);
    expect([...diagnostics.keys()]).toEqual([
      "ANALYZE_UNSAFE_XML_DECLARATION",
      "ANALYZE_UNSAFE_ACTIVE_ELEMENT",
      "ANALYZE_UNSAFE_ACTIVE_ATTRIBUTE",
      "ANALYZE_UNSAFE_EXTERNAL_REFERENCE",
      "ANALYZE_UNSUPPORTED_ELEMENT",
      "ANALYZE_UNSUPPORTED_ATTRIBUTE",
      "ANALYZE_UNSUPPORTED_CSS_CLASS",
      "ANALYZE_UNSUPPORTED_VERSION",
      "ANALYZE_UNSUPPORTED_NAMESPACE",
      "ANALYZE_UNSUPPORTED_PAINT",
      "ANALYZE_UNSUPPORTED_TRANSFORM",
      "ANALYZE_UNSUPPORTED_XML_NODE",
      "ANALYZE_INVALID_ROOT",
      "ANALYZE_MISSING_ARTWORK",
      "ANALYZE_INVALID_VIEWBOX",
      "ANALYZE_INVALID_CANVAS_DIMENSION",
      "ANALYZE_INVALID_ID",
      "ANALYZE_INVALID_GEOMETRY",
      "ANALYZE_INVALID_PATH_DATA",
      "ANALYZE_INVALID_ACCESSIBILITY",
      "ANALYZE_INVALID_REFERENCE",
      "ANALYZE_INVALID_SHAPE_RENDERING",
      "ANALYZE_SYNTAX_ERROR",
      "ANALYZE_INVALID_UTF8",
      "ANALYZE_FILE_BYTE_LIMIT_EXCEEDED",
      "ANALYZE_FILE_ELEMENT_LIMIT_EXCEEDED",
      "ANALYZE_PROFILE_ELEMENT_LIMIT_EXCEEDED",
      "ANALYZE_PROFILE_DEPTH_LIMIT_EXCEEDED",
      "ANALYZE_CANDIDATE_LIMIT_EXCEEDED",
      "ANALYZE_SVG_FILE_LIMIT_EXCEEDED",
      "ANALYZE_AGGREGATE_BYTE_LIMIT_EXCEEDED",
      "ANALYZE_ANALYSIS_ELEMENT_LIMIT_EXCEEDED",
      "ANALYZE_ARCHIVE_BYTE_LIMIT_EXCEEDED",
      "ANALYZE_ARCHIVE_DECLARED_BYTE_LIMIT_EXCEEDED",
      "ANALYZE_ARCHIVE_COMPRESSION_RATIO_EXCEEDED",
      "ANALYZE_ARCHIVE_INVALID",
      "ANALYZE_INPUT_INVALID",
      "ANALYZE_SOURCE_CHANGED",
      "ANALYZE_SNAPSHOT_FAILED",
      "ANALYZE_DETAILS_TARGET_INVALID",
      "ANALYZE_DETAILS_WRITE_FAILED",
    ]);
    expect(diagnostics.get("ANALYZE_FILE_ELEMENT_LIMIT_EXCEEDED")).toMatchObject({ data: "complete", classification: "unsupported" });
    expect(diagnostics.get("ANALYZE_ANALYSIS_ELEMENT_LIMIT_EXCEEDED")).toMatchObject({ data: "null", classification: null });
    for (const entry of contract.diagnostics) {
      if (entry.data === "null") {
        expect(entry).toMatchObject({ classification: null, scanImpact: "scan_abort" });
      } else if (entry.classification === "unsafe") {
        expect(entry).toMatchObject({ data: "complete", scanImpact: "unsafe_dominates" });
      } else {
        expect(entry).toMatchObject({ data: "complete", classification: "unsupported", scanImpact: "drift_candidate" });
      }
    }

    expect(contract.normalizations.map((entry: { id: string }) => entry.id)).toEqual([
      "accessibility_authority_required",
      "canonicalize_definition_order",
      "canonicalize_svg_version",
      "declare_decorative",
      "geometry_defaults_expanded",
      "labelled_ids_and_references",
      "promote_root_presentation",
      "rect_corner_completion",
      "title_only_to_labelled",
      "xlink_href_to_href",
      "xlink_namespace_to_svg2_href",
    ]);
  });
});
