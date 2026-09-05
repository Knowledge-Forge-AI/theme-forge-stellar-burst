import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildProject,
  bundleProject,
  checkProject,
  diffProject,
  importProject,
  installProject,
  listProject,
  planImport,
  reconcileProject,
} from "../src/index.js";
import { readSvgArchive } from "../src/archive.js";
import { makeTempDir, readRepoFile, repoPath, stableJson } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function root(prefix = "tfsb34-"): string { const value = makeTempDir(prefix); roots.push(value); return value; }
async function archive(base: string, name: string, files: Readonly<Record<string, string>>): Promise<string> {
  const path = join(base, name);
  await writeFile(path, zipSync(Object.fromEntries(Object.entries(files).map(([entry, text]) => [entry, Buffer.from(text)])), { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
  return path;
}

describe("TFSB34 combined v0.3 qualification", () => {
  it("matches normalization dry-run evidence to the applied multi-authority lifecycle", async () => {
    const base = root();
    const source = await archive(base, "combined.zip", {
      "icons/title.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>Observed title</title><path d="M0 0L1 1"/></svg>',
      "icons/decorative.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><g opacity="0.5"><circle r="2"/><rect width="4" height="3" rx="1"/><line/><polyline points="0,0  1,1"/><polygon points="0,0 2,0 1,2"/></g></svg>',
      "icons/consumer.svg": '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0  0 20 20" stroke="currentColor"><defs><linearGradient id="paint" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient><path id="glyph" d="M0 0L1 1"/></defs><g transform="translate(1 2) rotate(45) scale(0.5)"><use xlink:href="#glyph" fill="url(#paint)  #123456"/></g></svg>',
    });
    const map = join(base, "normalization-map.toml");
    await writeFile(map, 'schema_version = 1\n\n[[entry]]\nsource = "icons/decorative.svg"\naccessibility = "decorative"\n\n[[entry]]\nsource = "icons/consumer.svg"\naccessibility = "consumer_labelled"\n');
    const dryRoot = join(base, "dry"); const appliedRoot = join(base, "applied");
    await mkdir(dryRoot); await mkdir(appliedRoot);
    const dry = await planImport({ archive: source, root: dryRoot, schema: 2, normalize: "exact-common", normalizationMap: map });
    const applied = await importProject({ archive: source, root: appliedRoot, schema: 2, normalize: "exact-common", normalizationMap: map });
    expect(applied.normalizationLedger).toEqual(dry.normalizationLedger);
    expect(applied.normalizationLedger?.entries.map((entry) => [entry.source, entry.consumedAccessibilityAuthority])).toEqual([
      ["icons/consumer.svg", "consumer_labelled"],
      ["icons/decorative.svg", "decorative"],
      ["icons/title.svg", null],
    ]);
    await buildProject(appliedRoot); await installProject(appliedRoot);
    expect(await checkProject(appliedRoot)).toMatchObject({ sourceChanged: false, build: { missing: [], different: [] }, install: { missing: [], different: [] } });
    expect((await listProject(appliedRoot)).assets).toHaveLength(3);
    expect(await diffProject({ root: appliedRoot, baseline: "archive", archive: source })).toMatchObject({ different: false, changes: [] });
    const bundle = await bundleProject({ root: appliedRoot, output: "combined.zip" });
    expect(bundle).toMatchObject({ written: true, assetCount: 3 });
  });

  it.each([
    ["script after artwork", '<path d="M0 0L1 1"/><script>seed()</script>'],
    ["root event", "", ' onclick="seed()"'],
    ["primitive event", '<path onclick="seed()" d="M0 0L1 1"/>'],
    ["group event", '<g onclick="seed()"><path d="M0 0L1 1"/></g>'],
    ["style element", '<style>.x{fill:red}</style><path d="M0 0L1 1"/>'],
    ["style attribute", '<path style="fill:red" d="M0 0L1 1"/>'],
    ["external href", '<use href="https://example.invalid/x.svg#g"/>'],
    ["external paint", '<path fill="url(https://example.invalid/p.svg#g)" d="M0 0L1 1"/>'],
    ["image", '<image href="x.png"/>'],
    ["foreignObject", '<foreignObject><div/></foreignObject>'],
    ["animation", '<path d="M0 0L1 1"><animate attributeName="opacity"/></path>'],
    ["protocol-relative URL", '<use href="//example.invalid/x.svg#g"/>'],
    ["data URL", '<image href="data:image/png;base64,seed"/>'],
    ["unknown namespace", '<foo:path xmlns:foo="urn:seed" d="M0 0L1 1"/>'],
  ] as const)("rejects unsafe %s before initial publication", async (_label, body, rootAttribute?: string) => {
    const base = root(); await mkdir(join(base, "project"));
    const source = await archive(base, "unsafe.zip", { "unsafe.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img"${rootAttribute ?? ""}>${body}</svg>` });
    const expectedCode = _label === "unknown namespace" ? "IMPORT_UNSUPPORTED_SOURCE" : "IMPORT_UNSAFE_SOURCE";
    await expect(importProject({ archive: source, root: join(base, "project"), schema: 2, normalize: "exact-common" })).rejects.toMatchObject({ diagnostic: { code: expectedCode } });
    await expect(access(join(base, "project", ".tfsb"))).rejects.toThrow();
  });

  it("rejects DOCTYPE/entity input before initial publication", async () => {
    const base = root(); await mkdir(join(base, "project"));
    const source = await archive(base, "doctype.zip", { "unsafe.svg": '<!DOCTYPE svg [<!ENTITY x "seed">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img"><path d="M0 0L1 1"/></svg>' });
    await expect(importProject({ archive: source, root: join(base, "project"), schema: 2, normalize: "exact-common" })).rejects.toMatchObject({ diagnostic: { code: "IMPORT_UNSAFE_SOURCE" } });
    await expect(access(join(base, "project", ".tfsb"))).rejects.toThrow();
  });

  it("rejects unsafe reconcile input without mutating the canonical project", async () => {
    const base = root(); const project = join(base, "project"); await mkdir(project);
    const original = await archive(base, "original.zip", { "a.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Safe</title><path d="M0 0L1 1"/></svg>' });
    await importProject({ archive: original, root: project, schema: 2, normalize: "exact-common" });
    const canonicalPath = join(project, ".tfsb", "assets", "a.toml"); const before = await readFile(canonicalPath);
    const changed = await archive(base, "unsafe-reconcile.zip", { "a.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Safe</title><path d="M0 0L2 2"/><script>seed()</script></svg>' });
    await expect(reconcileProject({ archive: changed, root: project, normalize: "exact-common" })).rejects.toMatchObject({ diagnostic: { code: "IMPORT_UNSAFE_SOURCE" } });
    expect(await readFile(canonicalPath)).toEqual(before);
  });

  it("accepts exact archive entry, selected-entry, and aggregate limits and rejects one over", async () => {
    const base = root();
    const exactEntries = {
      ...Object.fromEntries(Array.from({ length: 1_023 }, (_, index) => [`notes/${index}.txt`, new Uint8Array()])),
      "a.svg": new Uint8Array([0x78]),
    };
    const exactEntriesPath = join(base, "entries-exact.zip");
    await writeFile(exactEntriesPath, zipSync(exactEntries, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    expect(await readSvgArchive(exactEntriesPath)).toHaveLength(1);
    const overEntriesPath = join(base, "entries-over.zip");
    await writeFile(overEntriesPath, zipSync({ ...exactEntries, "notes/1023.txt": new Uint8Array() }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    await expect(readSvgArchive(overEntriesPath)).rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" } });

    const exactBytesPath = join(base, "bytes-exact.zip");
    await writeFile(exactBytesPath, zipSync({ "large.svg": new Uint8Array(8 * 1024 * 1024) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    expect(await readSvgArchive(exactBytesPath)).toHaveLength(1);
    const overBytesPath = join(base, "bytes-over.zip");
    await writeFile(overBytesPath, zipSync({ "large.svg": new Uint8Array(8 * 1024 * 1024 + 1) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    await expect(readSvgArchive(overBytesPath)).rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" } });

    const chunk = new Uint8Array(8 * 1024 * 1024);
    const exactAggregate = { "a.svg": chunk, "b.svg": chunk, "c.svg": chunk, "d.svg": chunk };
    const exactAggregatePath = join(base, "aggregate-exact.zip");
    await writeFile(exactAggregatePath, zipSync(exactAggregate, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    expect(await readSvgArchive(exactAggregatePath)).toHaveLength(4);
    const overAggregatePath = join(base, "aggregate-over.zip");
    await writeFile(overAggregatePath, zipSync({ ...exactAggregate, "e.svg": new Uint8Array([0x78]) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    await expect(readSvgArchive(overAggregatePath)).rejects.toMatchObject({ diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" } });
  }, 20_000);

  it("freezes aggregate-only dogfood evidence and required shard topology", () => {
    const parsed = JSON.parse(readRepoFile("docs/evaluations/v0.3-dogfood-shard-qualification.json")) as Record<string, unknown> & { aggregateDigest: string; corpora: { corpus: string; before: unknown; after: unknown; shards: { name: string; lifecycleOutcome: { status: string } }[] }[] };
    const { aggregateDigest, ...body } = parsed;
    expect(`sha256:${createHash("sha256").update(stableJson(body)).digest("hex")}`).toBe(aggregateDigest);
    expect(parsed.corpora.flatMap((corpus) => corpus.shards.map((shard) => shard.name))).toEqual([
      "lucide-16", "lucide-32", "lucide-128",
      "simple-icons-16", "simple-icons-32",
      "tabler-outline-16", "tabler-outline-32", "tabler-filled-16", "tabler-filled-32", "tabler-paired-128",
      "thesvg-directly-importable-inventory", "thesvg-importable-with-normalization-inventory", "thesvg-unsupported-inventory", "thesvg-unsafe-inventory",
    ]);
    expect(parsed.corpora.every((corpus) => stableJson(corpus.before) === stableJson(corpus.after))).toBe(true);
    expect(parsed.corpora.find((corpus) => corpus.corpus === "thesvg")?.shards.every((shard) => shard.lifecycleOutcome.status === "inventory_only")).toBe(true);
    expect(readRepoFile("docs/evaluations/v0.3-dogfood-shard-qualification.json")).not.toContain('"entries"');
  });

  it("validates package payload, dependencies, and file allowlist against repository policy", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      name: string;
      version: string;
      files: string[];
      dependencies: Record<string, string>;
      exports: Record<string, unknown>;
      bin: Record<string, string>;
    };
    expect(pkg.name).toBe("@knowledge-forge-ai/theme-forge-stellar-burst");
    expect(pkg.version).toBe("0.4.0");
    expect(pkg.files).toEqual(["dist", "protocol/tfsb-studio-v1", "protocol/tfsb-design-evidence-v1", "native/directory-snapshot/prebuilds", "NOTICE", "COMMERCIAL-LICENSE.md"]);
    expect(pkg.dependencies).toEqual({
      "@xmldom/xmldom": "0.9.12",
      fflate: "0.8.3",
      "smol-toml": "1.8.0",
    });
    expect(pkg.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./studio-protocol/v1": {
        types: "./dist/service-protocol/v1-types.d.ts",
        import: "./dist/service-protocol/v1-types.js",
      },
      "./design-evidence/v1": {
        types: "./dist/design-evidence/index.d.ts",
        import: "./dist/design-evidence/index.js",
      },
    });
    expect(pkg.bin).toEqual({
      tfsb: "./dist/cli.js",
      "tfsb-studio-service": "./dist/service-protocol/server-cli.js",
    });

    const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
    const [packResult] = JSON.parse(packOutput) as [{ files: { path: string; size: number }[]; entryCount: number }];
    expect(packResult).toBeDefined();
    const paths = packResult?.files.map((f) => f.path) ?? [];
    const nativePaths = paths.filter((path) => path.startsWith("native/directory-snapshot/prebuilds/"));
    // TFSB45B1 adds six genuine production modules (JS + declarations) and
    // twenty-five closed mutation protocol examples: 37 entries above TFSB45A.
    // TFSB47B2 adds four genuine brand package/bundle/import production modules (JS + declarations):
    // 8 entries above TFSB47B1.
    // TFSB47C adds four genuine brand tokens/recipes/derive production modules (JS + declarations):
    // 8 entries above TFSB47B2.
    // TFSB47D adds seven genuine QA/diff production modules (JS + declarations):
    // 14 entries above TFSB47C.
    // TFSB47E adds five genuine consumer distribution modules (JS + declarations):
    // 10 entries above TFSB47D.
    // TFSB47F adds four genuine raster export modules (JS + declarations):
    // 8 entries above TFSB47E; the optional companion is independently packed.
    // TFSB47G adds the Studio brand adapter (JS + declaration), three 1.1
    // machine artifacts, and two versioned example files: 7 entries.
    // TFSB47J adds bounded visual evidence (JS + declaration), three 1.2
    // machine artifacts, and two versioned example files: 7 entries.
    // TFSB47L adds five design-evidence modules (JS + declarations), three
    // schemas, inventory/README, four canonical examples, and one shared
    // negative corpus: 20 entries.
    expect(packResult?.entryCount).toBe(296 + nativePaths.length);
    expect(paths.length).toBe(296 + nativePaths.length);
    expect(paths).toEqual(expect.arrayContaining([
      "dist/brand/brand-files.d.ts",
      "dist/brand/brand-files.js",
      "dist/brand/brand-schema.d.ts",
      "dist/brand/brand-schema.js",
      "dist/brand/brand-digests.d.ts",
      "dist/brand/brand-digests.js",
      "dist/brand/brand-availability.d.ts",
      "dist/brand/brand-availability.js",
      "dist/brand/brand-core.d.ts",
      "dist/brand/brand-core.js",
      "dist/brand/brand-package.d.ts",
      "dist/brand/brand-package.js",
      "dist/brand/brand-bundle-manifest.d.ts",
      "dist/brand/brand-bundle-manifest.js",
      "dist/brand/brand-bundle.d.ts",
      "dist/brand/brand-bundle.js",
      "dist/brand/brand-import.d.ts",
      "dist/brand/brand-import.js",
      "dist/brand/tokens.d.ts",
      "dist/brand/tokens.js",
      "dist/brand/recipes.d.ts",
      "dist/brand/recipes.js",
      "dist/brand/derived-receipt.d.ts",
      "dist/brand/derived-receipt.js",
      "dist/brand/derive.d.ts",
      "dist/brand/derive.js",
      "dist/design-evidence/index.d.ts",
      "dist/design-evidence/index.js",
      "protocol/tfsb-design-evidence-v1/inventory.json",
      "protocol/tfsb-design-evidence-v1/negative-corpus.json",
      "protocol/tfsb-design-evidence-v1/examples/review.json",
      "dist/brand/qa-schema.d.ts",
      "dist/brand/qa-schema.js",
      "dist/brand/qa-semantic.d.ts",
      "dist/brand/qa-semantic.js",
      "dist/brand/qa-capability.d.ts",
      "dist/brand/qa-capability.js",
      "dist/brand/qa-report.d.ts",
      "dist/brand/qa-report.js",
      "dist/brand/qa-baseline.d.ts",
      "dist/brand/qa-baseline.js",
      "dist/brand/brand-diff.d.ts",
      "dist/brand/consumer-profile.d.ts",
      "dist/brand/consumer-profile.js",
      "dist/brand/consumer-lock.d.ts",
      "dist/brand/consumer-lock.js",
      "dist/brand/consumer-source.d.ts",
      "dist/brand/consumer-source.js",
      "dist/brand/consumer-plan.d.ts",
      "dist/brand/consumer-plan.js",
      "dist/brand/consumer-install.d.ts",
      "dist/brand/consumer-install.js",
      "dist/brand/export-profile.d.ts",
      "dist/brand/export-profile.js",
      "dist/brand/export-plan.d.ts",
      "dist/brand/export-plan.js",
      "dist/brand/raster-receipt.d.ts",
      "dist/brand/raster-receipt.js",
      "dist/brand/raster-capability.d.ts",
      "dist/brand/raster-capability.js",
      "dist/brand/brand-diff.js",
      "dist/brand/visual-diff.d.ts",
      "dist/brand/visual-diff.js",
      "dist/directory-snapshot.d.ts",
      "dist/directory-snapshot.js",
      "dist/directory-snapshot-native.d.ts",
      "dist/directory-snapshot-native.js",
      "dist/source-identity.d.ts",
      "dist/source-identity.js",
      "dist/source-map.d.ts",
      "dist/source-map.js",
      "dist/provenance3.d.ts",
      "dist/provenance3.js",
      "dist/workspace.d.ts",
      "dist/workspace.js",
      "dist/workspace-check.d.ts",
      "dist/workspace-check.js",
      "dist/workspace-collisions.d.ts",
      "dist/workspace-collisions.js",
      "dist/workspace-list.d.ts",
      "dist/workspace-list.js",
      "dist/workspace-preview.d.ts",
      "dist/workspace-preview.js",
      "dist/shard.d.ts",
      "dist/shard.js",
      "dist/reconcile-directory.d.ts",
      "dist/reconcile-directory.js",
      "dist/edit.d.ts",
      "dist/edit.js",
      "dist/plan-retention.d.ts",
      "dist/plan-retention.js",
      "dist/service-protocol/authority-ledger.d.ts",
      "dist/service-protocol/authority-ledger.js",
      "dist/service-protocol/canonical-json.d.ts",
      "dist/service-protocol/canonical-json.js",
      "dist/service-protocol/brand-methods.d.ts",
      "dist/service-protocol/brand-methods.js",
      "dist/service-protocol/brand-visual-methods.d.ts",
      "dist/service-protocol/brand-visual-methods.js",
      "dist/service-protocol/mutation-methods.d.ts",
      "dist/service-protocol/mutation-methods.js",
      "dist/service-protocol/plan-registry.d.ts",
      "dist/service-protocol/plan-registry.js",
      "dist/service-protocol/server-cli.js",
      "dist/service-protocol/v1-types.d.ts",
      "protocol/tfsb-studio-v1/inventory.json",
      "protocol/tfsb-studio-v1/inventory-1.1.json",
      "protocol/tfsb-studio-v1/inventory-1.2.json",
      "protocol/tfsb-studio-v1/requests.schema.json",
      "protocol/tfsb-studio-v1/requests-1.1.schema.json",
      "protocol/tfsb-studio-v1/requests-1.2.schema.json",
      "protocol/tfsb-studio-v1/results-1.1.schema.json",
      "protocol/tfsb-studio-v1/results-1.2.schema.json",
      "protocol/tfsb-studio-v1/examples/1.1/requests.json",
      "protocol/tfsb-studio-v1/examples/1.1/results.json",
      "protocol/tfsb-studio-v1/examples/1.2/requests.json",
      "protocol/tfsb-studio-v1/examples/1.2/results.json",
      "protocol/tfsb-studio-v1/examples/asset-edit-plan-request.json",
      "protocol/tfsb-studio-v1/examples/plan-apply-result.json",
    ]));
    expect(nativePaths.length).toBeGreaterThanOrEqual(2);
    for (const path of nativePaths) {
      expect(path).toMatch(/^native\/directory-snapshot\/prebuilds\/(?:darwin-arm64|darwin-x64|linux-x64-gnu)\/(?:manifest\.json|native-addon-posix-openat-v1\.node)$/);
    }
    for (const path of paths) {
      const allowed = path.startsWith("dist/") || path.startsWith("protocol/tfsb-studio-v1/") || path.startsWith("protocol/tfsb-design-evidence-v1/") || nativePaths.includes(path) || path === "NOTICE" || path === "COMMERCIAL-LICENSE.md" || path === "LICENSE" || path === "package.json" || path === "README.md";
      expect(allowed, `Unexpected file in package payload: ${path}`).toBe(true);
      expect(path).not.toMatch(/^(?:test|tools|docs|scratch)\b/);
      expect(path).not.toMatch(/dogfood|eval/i);
    }
  }, 20_000);

  it("keeps release-acceptance arithmetic complete and executable-evidence based", () => {
    const matrix = JSON.parse(readRepoFile("docs/evaluations/v0.3-release-acceptance.json")) as {
      packageVersion: string;
      releaseStatus: string;
      summary: { qualified: number; blocked: number; docsOnly: number; total: number };
      rows: { feature: string; implementation: string[]; tests: string[]; disposition: string }[];
    };
    expect(matrix).toMatchObject({ packageVersion: "0.3.0", releaseStatus: "release-candidate" });
    expect(matrix.summary.total).toBe(matrix.rows.length);
    expect(matrix.summary.qualified).toBe(matrix.rows.filter((row) => row.disposition === "qualified").length);
    expect(matrix.summary.blocked).toBe(matrix.rows.filter((row) => row.disposition === "blocked").length);
    expect(matrix.summary.docsOnly).toBe(matrix.rows.filter((row) => row.tests.every((test) => test.startsWith("docs/"))).length);
    expect(matrix.rows.every((row) => {
      if (row.tests.length === 0) return false;
      return row.tests.every((testPath) => {
        return existsSync(repoPath(testPath)) && (testPath.endsWith(".test.ts") || testPath.endsWith(".spec.ts"));
      });
    })).toBe(true);
    expect(matrix.rows.every((row) => {
      return row.implementation.length > 0 && row.implementation.every((implPath) => existsSync(repoPath(implPath)));
    })).toBe(true);
    expect(matrix.rows.map((row) => row.feature)).toEqual(expect.arrayContaining([
      "analyze", "schema 2", "accessibility modes", "presentation and currentColor", "primitives",
      "transforms groups references", "direct import", "exact-common normalization",
      "normalization map and policy digest", "provenance2", "migration", "schema-2 reconcile",
      "archive diff", "bundle and manifest", "fmt build install check list", "preview",
      "schema-1 frozen compatibility", "limits security transaction", "package payload and dependency policy",
    ]));
  });
});
