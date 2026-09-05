import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TERMINAL_NOVA_ASSETS, sha256Hex } from "../tools/qualify-terminal-nova-brand.mjs";
import {
  executeTerminalNovaCoreMatrix,
  derivePlanMethods,
} from "../tools/tfsb48-r2/core-matrix.mjs";
import {
  canonicalJson,
  validateCoreMatrixResult,
} from "../tools/tfsb48-r2/core-result-schema.mjs";
import { inspectLimitsDisposition } from "../tools/tfsb48-r2/limits-disposition.mjs";

type Corpus = {
  git: { commit: string; tree: string; clean: true };
  readmeBytes: Uint8Array;
  assetMap: Record<string, { bytes: Uint8Array; sha256: string }>;
};

type CoreCase = {
  id: string;
  status: "pass" | "fail" | "unavailable";
  reasonCode: string;
  observations: Record<string, unknown>;
  artifacts: readonly Record<string, unknown>[];
};

type CoreResult = {
  summary: { pass: number; fail: number; unavailable: number; status: string };
  cases: CoreCase[];
  planRegistry: { source: string; methods: string[]; exercisedMethods: string[]; completionRole: string };
};

type LimitRow = {
  owner: { source: string; exportedBounds: readonly unknown[] };
  existingExecutableCoverage: readonly string[];
  boundaryEvidence: { atLimitRun: boolean };
  disposition: string;
};

type LimitsResult = {
  schema: string;
  completionGateRows: readonly string[];
  removedRows: readonly string[];
  rows: readonly LimitRow[];
};

const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureCorpus(): Promise<Corpus> {
  const fixtureRoot = resolve("test/fixtures/tftn-production-v1");
  const assetEntries = await Promise.all(TERMINAL_NOVA_ASSETS.map(async (asset) => {
    const bytes = await readFile(join(fixtureRoot, asset.filename));
    return [asset.id, { bytes, sha256: sha256Hex(bytes) }] as const;
  }));
  return {
    git: { commit: "1".repeat(40), tree: "2".repeat(40), clean: true },
    readmeBytes: await readFile(join(fixtureRoot, "brand-README.md")),
    assetMap: Object.fromEntries(assetEntries),
  };
}

describe("TFSB48-R2 Terminal Nova core matrix", () => {
  it("derives the five production plan methods without a copied registry", async () => {
    await expect(derivePlanMethods()).resolves.toEqual([
      "brand.derive.plan",
      "brand.qa.baseline.plan",
      "brand.consumer.install.plan",
      "brand.consumer.sync.plan",
      "brand.export.plan",
    ]);
  });

  it("executes the portable matrix with classified unavailable rows", async () => {
    const corpus = await fixtureCorpus();
    const scratch = await mkdtemp(join(tmpdir(), "tfsb48-r2-core-matrix-"));
    scratchRoots.push(scratch);

    const result = await executeTerminalNovaCoreMatrix({ scratchRoot: scratch, corpus }) as unknown as CoreResult;
    expect(() => validateCoreMatrixResult(result)).not.toThrow();
    expect(result.summary.fail).toBe(0);
    expect(new Set(result.cases.map((row) => row.id)).size).toBe(result.cases.length);
    expect(result.planRegistry).toEqual({
      source: "production-owner-derived:BRAND_PLAN_METHODS",
      methods: [
        "brand.derive.plan",
        "brand.qa.baseline.plan",
        "brand.consumer.install.plan",
        "brand.consumer.sync.plan",
        "brand.export.plan",
      ],
      exercisedMethods: [
        "brand.derive.plan",
        "brand.consumer.install.plan",
        "brand.consumer.sync.plan",
        "brand.export.plan",
      ],
      completionRole: "owner-fact-not-complete-protocol-gate",
    });

    const rows = new Map(result.cases.map((row) => [row.id, row]));
    for (const id of [
      "corpus-authentication",
      "bundle-create-validate-import",
      "derive-source-owned-noop",
      "qa-semantic-validation",
      "destination-topology",
      "recipe-rejection-source-ownership",
      "consumer-install-clean-sync",
      "offline-local-bundle-consumer",
      "unowned-collision",
      "source-drift",
      "stale-plan",
      "destination-drift",
      "stale-lock",
      "successful-apply",
      "failed-apply-exact-rollback",
      "two-run-byte-determinism",
    ]) {
      expect(rows.get(id)?.status, id).toBe("pass");
    }
    expect(rows.has("offline-npm-packed-consumer")).toBe(false);
    for (const id of ["source-drift", "stale-plan", "destination-drift", "stale-lock", "successful-apply", "failed-apply-exact-rollback"]) {
      expect(rows.get(id)?.artifacts.length, `${id} state artifacts`).toBeGreaterThanOrEqual(3);
    }
    expect(JSON.stringify(result)).not.toMatch(/\/(?:Users|private|var|tmp|Volumes)\//u);
    expect(canonicalJson(result)).toBe(canonicalJson(validateCoreMatrixResult(result)));
  }, 120_000);

  it("derives owner facts and removes generic literal limits from completion", async () => {
    const corpus = await fixtureCorpus();
    const first = await inspectLimitsDisposition({ corpus }) as unknown as LimitsResult;
    const second = await inspectLimitsDisposition({ corpus }) as unknown as LimitsResult;

    expect(first.schema).toBe("tfsb.terminal-nova-limits-disposition");
    expect(first.completionGateRows).toEqual([]);
    expect(first.removedRows).toHaveLength(first.rows.length);
    expect(first.rows).toHaveLength(9);
    for (const row of first.rows) {
      expect(row.owner.source).toMatch(/^src\//u);
      expect(row.owner.exportedBounds.length).toBeGreaterThan(0);
      expect(row.existingExecutableCoverage.length).toBeGreaterThan(0);
      expect(row.boundaryEvidence.atLimitRun).toBe(false);
      expect(row.disposition).toBe("removed-from-TFSB48-completion");
    }
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(JSON.stringify(first)).not.toMatch(/\/(?:Users|private|var|tmp|Volumes)\//u);
  });

  it("fails closed for an unauthenticated or inconsistent corpus", async () => {
    const corpus = await fixtureCorpus();
    const scratch = await mkdtemp(join(tmpdir(), "tfsb48-r2-core-invalid-"));
    scratchRoots.push(scratch);

    await expect(executeTerminalNovaCoreMatrix({
      scratchRoot: scratch,
      corpus: { ...corpus, git: { ...corpus.git, clean: false } },
    })).rejects.toThrow("CORE_CORPUS_NOT_CLEAN");

    const invalidResult = {
      schema: "tfsb.terminal-nova-core-matrix",
      schemaVersion: 1,
      corpus: {
        commit: "1".repeat(40),
        tree: "2".repeat(40),
        clean: true,
        readmeDigest: "sha256:" + "0".repeat(64),
      },
      planRegistry: {
        source: "production-owner-derived:BRAND_PLAN_METHODS",
        methods: ["brand.derive.plan"],
        exercisedMethods: ["brand.derive.plan"],
        completionRole: "owner-fact-not-complete-protocol-gate",
      },
      cases: [],
      summary: { pass: 1, fail: 0, unavailable: 0, status: "pass" },
    };
    expect(() => validateCoreMatrixResult(invalidResult)).toThrow("CORE_RESULT_SUMMARY_MISMATCH");
  });
});
