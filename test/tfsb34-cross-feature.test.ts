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
  });

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
    expect(pkg.version).toBe("0.3.0");
    expect(pkg.files).toEqual(["dist", "NOTICE", "COMMERCIAL-LICENSE.md"]);
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
    });
    expect(pkg.bin).toEqual({
      tfsb: "./dist/cli.js",
    });

    const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
    const [packResult] = JSON.parse(packOutput) as [{ files: { path: string; size: number }[]; entryCount: number }];
    expect(packResult).toBeDefined();
    expect(packResult?.entryCount).toBe(103);
    const paths = packResult?.files.map((f) => f.path) ?? [];
    expect(paths.length).toBe(103);
    for (const path of paths) {
      const allowed = path.startsWith("dist/") || path === "NOTICE" || path === "COMMERCIAL-LICENSE.md" || path === "LICENSE" || path === "package.json" || path === "README.md";
      expect(allowed, `Unexpected file in package payload: ${path}`).toBe(true);
      expect(path).not.toMatch(/^(?:test|tools|docs|scratch)\b/);
      expect(path).not.toMatch(/dogfood|eval/i);
    }
  });

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
