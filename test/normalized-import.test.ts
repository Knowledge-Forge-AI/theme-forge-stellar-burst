import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  executeImport,
  computeRawSha256,
  importProject,
  parseAssetTomlV2,
  parseImportProvenanceV2,
  parseSvgV2,
  planImport,
  serializeSvgV2,
  serializeBundleManifest,
} from "../src/index.js";
import type { AssetId } from "../src/types.js";
import { runCli } from "../src/cli.js";
import { makeTempDir, readRepoFile, unwrap } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function root(): string { const value = makeTempDir("tfsb-normalized-import-"); roots.push(value); return value; }
async function archive(base: string, files: Record<string, string>): Promise<string> { const path = join(base, "source.zip"); await writeFile(path, zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)])), { level: 0, mtime: new Date("1980-01-02T00:00:00Z") })); return path; }

describe("schema-2 exact-common import", () => {
  it("keeps canonical direct import direct while optionally recording truthful provenance 2", async () => {
    const base = root();
    const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml")));
    const canonical = unwrap(serializeSvgV2(asset.svg));
    const source = await archive(base, { "direct.svg": canonical });
    const plan = await importProject({ archive: source, root: base, schema: 2, recordProvenance: true });
    expect(plan.normalizationLedger).toBeUndefined();
    const provenance = unwrap(parseImportProvenanceV2(await readFile(join(base, ".tfsb", "provenance.json"), "utf8")));
    expect(provenance.records[0]).toMatchObject({ type: "asset", archive: { canonicalBasis: "tfsb-asset-toml-v2" }, migration: null, normalizationPolicy: null });
  });

  it("normalizes title-only input with a complete ledger and no invented description", async () => {
    const base = root();
    const source = await archive(base, { "icons/title.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Observed title</title><path d="M0 0L1 1"/></svg>' });
    await expect(importProject({ archive: source, root: base, schema: 2 })).rejects.toMatchObject({ diagnostic: { code: "IMPORT_NORMALIZATION_REQUIRED" } });
    const plan = await importProject({ archive: source, root: base, schema: 2, normalize: "exact-common" });
    expect(plan.normalizationLedger?.entries[0]).toMatchObject({ source: "icons/title.svg", operations: expect.arrayContaining(["title_only_to_labelled"]), disposition: "normalized" });
    const normalized = plan.assets[0];
    expect(normalized?.schemaVersion).toBe(2);
    if (normalized?.schemaVersion === 2) expect(normalized.svg.accessibility).toMatchObject({ mode: "labelled", title: "Observed title" });
    expect(JSON.stringify(normalized)).not.toContain("description");
  });

  it("renders a bounded normalization dry-run ledger without source text or absolute paths", async () => {
    const base = root(); const observed = "Private observed title"; const pathData = "M0 0L9 9";
    const source = await archive(base, { "icons/title.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>${observed}</title><path d="${pathData}"/></svg>` });
    let stdout = ""; let stderr = "";
    expect(await runCli(["import", source, "--root", base, "--schema", "2", "--normalize", "exact-common", "--dry-run"], base, { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } })).toBe(0);
    expect(stderr).toBe(""); expect(stdout).toContain("title_only_to_labelled"); expect(stdout).not.toContain(observed); expect(stdout).not.toContain(pathData); expect(stdout).not.toContain(base);
    await expect(access(join(base, ".tfsb"))).rejects.toThrow();
  });

  it.each(["decorative", "consumer_labelled"] as const)("requires and consumes explicit %s authority for unlabeled input", async (authority) => {
    const base = root();
    const source = await archive(base, { "icons/unlabelled.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L1 1"/></svg>' });
    await expect(importProject({ archive: source, root: base, schema: 2, normalize: "exact-common" })).rejects.toMatchObject({ diagnostic: { code: "NORMALIZATION_AUTHORITY_REQUIRED" } });
    const map = join(base, "normalization.toml");
    await writeFile(map, `schema_version = 1\n\n[[entry]]\nsource = "icons/unlabelled.svg"\naccessibility = "${authority}"\n`);
    const plan = await importProject({ archive: source, root: base, schema: 2, normalize: "exact-common", normalizationMap: map });
    expect(plan.normalizationLedger?.entries[0]?.consumedAccessibilityAuthority).toBe(authority);
    const normalized = plan.assets[0]; if (normalized?.schemaVersion === 2) expect(normalized.svg.accessibility.mode).toBe(authority);
    const provenance = unwrap(parseImportProvenanceV2(await readFile(join(base, ".tfsb", "provenance.json"), "utf8")));
    expect(provenance.records[0]).toMatchObject({ normalizationPolicy: { policyBasis: "tfsb-normalization-policy-v1", mapSha256: expect.stringMatching(/^sha256:/) } });
  });

  it("normalizes local xlink and parser whitespace but refuses unsafe external content", async () => {
    const base = root();
    const local = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0  0 10 10" role="img"><defs><path id="glyph" d="M0 0L1 1"/></defs><use xlink:href="#glyph"/></svg>';
    const source = await archive(base, { "local.svg": local });
    const plan = await importProject({ archive: source, root: base, schema: 2, normalize: "exact-common" });
    expect(plan.normalizationLedger?.entries[0]?.operations).toEqual(expect.arrayContaining(["xlink_href_to_href", "xlink_namespace_to_svg2_href", "canonicalize_parser_whitespace"]));
    const unsafeRoot = root(); const unsafe = await archive(unsafeRoot, { "unsafe.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" role="img"><use href="https://example.invalid/x.svg#g"/></svg>' });
    await expect(importProject({ archive: unsafe, root: unsafeRoot, schema: 2, normalize: "exact-common" })).rejects.toMatchObject({ diagnostic: { code: "IMPORT_UNSAFE_SOURCE" } });
    await expect(access(join(unsafeRoot, ".tfsb"))).rejects.toThrow();
  });

  it("normalizes root presentation, all basic shapes, defaults, rect corners, and definition order", async () => {
    const base = root();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 20 20" role="img" fill="currentColor" stroke="none"><g><circle r="2"/><ellipse rx="2" ry="1"/><rect width="4" height="3" rx="1"/><line/><polyline points="0,0 1,1"/><polygon points="0,0 2,0 1,2"/><use href="#shape"/></g><defs><path id="shape" d="M0 0L1 1"/></defs></svg>';
    const source = await archive(base, { "shapes.svg": svg });
    const plan = await importProject({ archive: source, root: base, schema: 2, normalize: "exact-common" });
    expect(plan.normalizationLedger?.entries[0]).toMatchObject({
      operations: expect.arrayContaining(["promote_root_presentation", "canonicalize_svg_version", "geometry_defaults_expanded", "rect_corner_completion", "canonicalize_definition_order"]),
    });
    expect(plan.normalizationLedger?.entries[0]?.beforeSemanticDigest).toBeNull();
    expect(plan.normalizationLedger?.entries[0]?.afterCanonicalDigest).toMatch(/^sha256:/);
    const asset = plan.assets[0];
    if (asset?.schemaVersion !== 2) throw new Error("Expected schema 2.");
    expect(asset.svg.presentation).toMatchObject({ fill: { type: "currentColor" }, stroke: { type: "none" } });
    const group = asset.svg.elements[0]; if (group?.type !== "group") throw new Error("Expected mixed group.");
    expect(group.children.map((child) => child.type)).toEqual(["circle", "ellipse", "rect", "line", "polyline", "polygon", "use"]);
    expect(group.children.find((child) => child.type === "rect")).toMatchObject({ type: "rect", x: 0, y: 0, cornerRadius: 1 });
    expect(asset.svg.definitions.paths[0]?.id).toBe("shape");
  });

  it("keeps canonical one-space gradient fallback direct and normalizes accepted multi-space fallback", async () => {
    const base = root();
    const sourceSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img"><defs><linearGradient id="paint" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient></defs><path fill="url(#paint) #123456" d="M0 0L1 1"/></svg>';
    const canonical = unwrap(serializeSvgV2(unwrap(parseSvgV2(sourceSvg))));
    const directArchive = await archive(base, { "gradient.svg": canonical });
    expect((await importProject({ archive: directArchive, root: base, schema: 2 })).normalizationLedger).toBeUndefined();
    const normalizedRoot = root(); const multi = await archive(normalizedRoot, { "gradient.svg": canonical.replace("url(#paint) #123456", "url(#paint)  #123456") });
    const multiPlan = await importProject({ archive: multi, root: normalizedRoot, schema: 2, normalize: "exact-common" });
    expect(multiPlan.normalizationLedger?.entries[0]?.operations).toContain("canonicalize_parser_whitespace");
    expect(multiPlan.normalizationLedger?.entries[0]?.beforeSemanticDigest).toBe(multiPlan.normalizationLedger?.entries[0]?.afterCanonicalDigest);
  });

  it("invalidates an authentic plan when its normalization map changes", async () => {
    const base = root(); const source = await archive(base, { "a.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0L1 1"/></svg>' });
    const map = join(base, "normalization.toml"); await writeFile(map, 'schema_version = 1\n[defaults]\nunlabelled_mode = "decorative"\n');
    const plan = await planImport({ archive: source, root: base, schema: 2, normalize: "exact-common", normalizationMap: map });
    await writeFile(map, 'schema_version = 1\n[defaults]\nunlabelled_mode = "consumer_labelled"\n');
    await expect(executeImport(plan)).rejects.toMatchObject({ diagnostic: { code: "NORMALIZATION_MAP_CHANGED" } });
    await expect(access(join(base, ".tfsb"))).rejects.toThrow();
  });

  it("reparses the complete normalized stage before initial promotion", async () => {
    const base = root(); const source = await archive(base, { "a.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0L1 1"/></svg>' });
    const map = join(base, "normalization.toml"); await writeFile(map, 'schema_version = 1\n[defaults]\nunlabelled_mode = "decorative"\n');
    const plan = await planImport({ archive: source, root: base, schema: 2, normalize: "exact-common", normalizationMap: map });
    await expect(executeImport(plan, { afterStageWrite: async () => {
      const stage = (await readdir(base)).find((name) => name.startsWith(".tfsb-stage-"))!;
      await writeFile(join(base, stage, "assets", "a.toml"), "invalid");
    } })).rejects.toBeDefined();
    await expect(access(join(base, ".tfsb"))).rejects.toThrow();
  });

  it("verifies manifest bytes and preserves manifest identity before normalization", async () => {
    const base = root();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>Manifest title</title><path d="M0 0L1 1"/></svg>');
    const manifest = serializeBundleManifest({ kind: "tfsb-bundle-manifest", schemaVersion: 1, generator: { name: "test", version: "1" }, files: [{ type: "asset", name: "logo.svg", assetId: "manifest-owned" as AssetId, sha256: computeRawSha256(svg) }] });
    const path = join(base, "manifest.zip"); await writeFile(path, zipSync({ "logo.svg": svg, "tfsb-manifest.json": Buffer.from(manifest) }, { level: 0, mtime: new Date("1980-01-02T00:00:00Z") }));
    const plan = await importProject({ archive: path, root: base, schema: 2, manifest: true, normalize: "exact-common" });
    expect(plan.assets[0]?.id).toBe("manifest-owned");
    expect(plan.normalizationLedger?.entries[0]).toMatchObject({ source: "logo.svg", disposition: "normalized" });
  });

  it("refuses to silently discard authored title/description under unlabelled accessibility authority", async () => {
    const base = root();
    const source = await archive(base, { "invoice.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-hidden="true"><title>Download invoice</title><desc>PDF format</desc><path d="M0 0L1 1"/></svg>' });
    const map = join(base, "normalization.toml");
    await writeFile(map, 'schema_version = 1\n[defaults]\nunlabelled_mode = "consumer_labelled"\n');
    await expect(importProject({ archive: source, root: base, schema: 2, normalize: "exact-common", normalizationMap: map })).rejects.toMatchObject({ diagnostic: { code: "IMPORT_UNSUPPORTED_SOURCE" } });
  });

  it("normalizes whitespace in fill color and points attributes", async () => {
    const base = root();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img"><polyline points="0,0  5,5"/><path fill=" #AABBCC " d="M0 0L1 1"/></svg>';
    const source = await archive(base, { "ws.svg": svg });
    const plan = await importProject({ archive: source, root: base, schema: 2, normalize: "exact-common" });
    expect(plan.normalizationLedger?.entries[0]?.operations).toContain("canonicalize_parser_whitespace");
    const asset = plan.assets[0];
    if (asset?.schemaVersion !== 2) throw new Error("Expected schema 2.");
    const polyline = asset.svg.elements[0];
    expect(polyline).toMatchObject({ type: "polyline", points: [[0, 0], [5, 5]] });
    const path = asset.svg.elements[1];
    expect(path).toMatchObject({ type: "path", fill: { type: "solid", color: "#AABBCC" } });
  });
});
