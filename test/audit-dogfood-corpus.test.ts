import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditCorpusDirectory,
  formatAuditMarkdown,
  stableJson,
} from "../tools/audit-dogfood-corpus.mjs";

const successfulParser = {
  parseSvg: () => ({
    ok: true as const,
    value: {
      canvas: { viewBox: [0, 0, 24, 24] },
      accessibility: { title: "Icon" },
      definitions: [],
      elements: [],
    },
  }),
  serializeAssetToml: (asset: { readonly id: string }) => `schema_version = 1\nid = "${asset.id}"\n`,
  serializeSvg: () => ({ ok: true as const, value: "<svg viewBox=\"0 0 24 24\"><path d=\"M0 0\"/></svg>\n" }),
};

describe("dogfood corpus audit", () => {
  it("sorts inputs and reports bounded deterministic aggregate evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-audit-"));
    await mkdir(join(root, "filled"));
    await mkdir(join(root, "outline"));
    await writeFile(
      join(root, "filled", "Same.svg"),
      '<svg viewBox="0 0 24 24" fill="currentColor"><title id="title">Icon</title><path d="M0 0"/></svg>',
    );
    await writeFile(
      join(root, "outline", "same.svg"),
      '<svg viewBox="0 0 24 24" fill="none"><path stroke="#000" transform="rotate(2)" d="M0 0"/></svg>',
    );
    await writeFile(join(root, "LICENSE"), "test license\n");

    const result = await auditCorpusDirectory(
      {
        id: "fixture",
        path: root,
        origin: "https://example.invalid/fixture.git",
        revision: "0123456789abcdef0123456789abcdef01234567",
        branch: "main",
        dirty: false,
        shallow: false,
      },
      successfulParser,
    );

    expect(result.scale.svgCount).toBe(2);
    expect(result.scale.duplicateBasenames.groups).toBe(1);
    expect(result.scale.assetIdCollisions.groups).toBe(1);
    expect(result.scale.portablePathCollisions.groups).toBe(0);
    expect(result.scale.companionCandidates.paths).toEqual(["LICENSE"]);
    expect(result.profile.paintValues).toMatchObject({
      currentColor: 1,
      hex: 1,
      none: 1,
    });
    expect(result.profile.transformFunctions).toEqual({ rotate: 1 });
    expect(result.compatibility).toMatchObject({ compatible: 2, incompatible: 0 });
    expect(result.compatibility.importableTogether).toBe(1);
    expect(result.compatibility.failureSamples).toEqual({});
    expect(result.projections.canonicalAssetToml.count).toBe(2);
    expect(result.projections.bundle.selectedShard128.possible).toBe(true);

    const summary = {
      schema: "tfsb-dogfood-corpus-audit",
      schemaVersion: 1,
      sampleLimit: 5,
      corpora: [result],
    };
    expect(stableJson(summary)).toBe(stableJson(summary));
    expect(formatAuditMarkdown(summary)).toContain("| fixture | 2 | 2 | 1 | 0 |");
    expect(stableJson(summary)).not.toContain(root);
  });

  it("groups stable diagnostics and bounds relative-path samples", async () => {
    const root = await mkdtemp(join(tmpdir(), "tfsb-audit-failures-"));
    for (let index = 6; index >= 0; index -= 1) {
      await writeFile(join(root, `bad-${index}.svg`), `<svg><circle data-index="${index}"/></svg>`);
    }
    const parser = {
      ...successfulParser,
      parseSvg: (_text: string, source?: string) => ({
        ok: false as const,
        diagnostics: [{ code: "XML_UNSUPPORTED_ELEMENT", ...(source === undefined ? {} : { source }) }],
      }),
    };

    const result = await auditCorpusDirectory(
      {
        id: "failures",
        path: root,
        origin: "https://example.invalid/failures.git",
        revision: "abcdef0123456789abcdef0123456789abcdef01",
        branch: null,
        dirty: true,
        shallow: false,
      },
      parser,
    );

    expect(result.compatibility.failureCodes).toEqual({ XML_UNSUPPORTED_ELEMENT: 7 });
    expect(result.compatibility.failureClasses).toEqual({ unsupportedSchema1: 7 });
    expect(result.compatibility.failureSamples.XML_UNSUPPORTED_ELEMENT).toEqual([
      "bad-0.svg",
      "bad-1.svg",
      "bad-2.svg",
      "bad-3.svg",
      "bad-4.svg",
    ]);
    expect(result.repository.branch).toBeNull();
    expect(result.repository.worktreeDirty).toBe(true);
  });

  it("executes the cli helper against real compiled dist with json and markdown output", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "tfsb-audit-smoke-"));
    const jsonOutput = join(outDir, "audit.json");
    const markdownOutput = join(outDir, "audit.md");
    const corpusArg = JSON.stringify({
      id: "tftn-production-v1",
      path: "test/fixtures/tftn-production-v1",
      origin: "https://example.invalid/fixture.git",
      revision: "0123456789abcdef0123456789abcdef01234567",
      branch: "main",
      dirty: false,
      shallow: false,
    });

    const scriptPath = join(process.cwd(), "tools/audit-dogfood-corpus.mjs");
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, "--corpus", corpusArg, "--json-output", jsonOutput, "--markdown-output", markdownOutput],
      { encoding: "utf8" },
    );

    expect(stdout).toBe("");
    const jsonContent = JSON.parse(await readFile(jsonOutput, "utf8"));
    const markdownContent = await readFile(markdownOutput, "utf8");

    expect(jsonContent.schema).toBe("tfsb-dogfood-corpus-audit");
    expect(jsonContent.corpora).toHaveLength(1);
    expect(jsonContent.corpora[0].id).toBe("tftn-production-v1");
    expect(jsonContent.corpora[0].compatibility.compatible).toBe(10);
    expect(markdownContent).toContain("| tftn-production-v1 | 10 | 10 | 0 | 0 |");

    await rm(outDir, { recursive: true, force: true });
  });
});
