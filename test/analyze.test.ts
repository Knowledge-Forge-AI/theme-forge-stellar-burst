import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ANALYZE_DIAGNOSTIC_REGISTRY,
  ANALYZE_FEATURE_CODE_REGISTRY,
  ANALYZE_NORMALIZATION_REGISTRY,
  analyze,
  analyzeDiagnosticSpec,
  createAnalyzeEnvelope,
  renderAnalyzeHuman,
  serializeAnalyzeDetailsLines,
  serializeJsonEnvelope,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function svg(body: string, root = ""): string { return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" role="img" aria-labelledby="title desc"${root}><title id="title">seed-title</title><desc id="desc">seed-description</desc>${body}</svg>`; }
async function fixture(files: Record<string, string | Uint8Array>): Promise<string> { const root = await realpath(await mkdtemp(join(tmpdir(), "tfsb-analyze-"))); roots.push(root); for (const [path, bytes] of Object.entries(files)) { const target = join(root, path); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, bytes); } return root; }

describe("productized compatibility analysis", () => {
  it("keeps the diagnostic, normalization, and feature registries closed and unique", () => {
    expect(ANALYZE_DIAGNOSTIC_REGISTRY).toHaveLength(41);
    expect(new Set(ANALYZE_DIAGNOSTIC_REGISTRY.map((row) => row[0])).size).toBe(41);
    expect(ANALYZE_NORMALIZATION_REGISTRY).toHaveLength(11);
    expect(new Set(ANALYZE_NORMALIZATION_REGISTRY).size).toBe(11);
    expect(new Set(ANALYZE_FEATURE_CODE_REGISTRY).size).toBe(ANALYZE_FEATURE_CODE_REGISTRY.length);
    expect(ANALYZE_FEATURE_CODE_REGISTRY).toEqual([...ANALYZE_FEATURE_CODE_REGISTRY].sort());
    for (const row of ANALYZE_DIAGNOSTIC_REGISTRY) expect(analyzeDiagnosticSpec(row[0])).toEqual(row);
  });

  it("mirrors every controlling machine-contract diagnostic row and normalization ID", async () => {
    const contract = JSON.parse(await readFile(join(process.cwd(), "docs/evaluations/v0.3-analyze-contract.json"), "utf8")) as { diagnostics: { code: string; domain: string; classification: string | null; data: string; scanImpact: string }[]; normalizations: { id: string }[] };
    expect(ANALYZE_DIAGNOSTIC_REGISTRY.map(([code, domain, classification, data, scanImpact]) => ({ code, domain, classification, data, scanImpact }))).toEqual(contract.diagnostics);
    expect(ANALYZE_NORMALIZATION_REGISTRY).toEqual(contract.normalizations.map(({ id }) => id));
  });

  it("classifies exact schema-1 accessibility directly in both profiles", async () => {
    const root = await fixture({ "exact.svg": svg('<path d="M0 0L1 1"/>') });
    const result = await analyze({ input: root });
    expect(result.status).toBe("ok");
    expect(result.data.profiles.schema1.counts.directlyImportable).toBe(1);
    expect(result.data.profiles.commonV03.counts.directlyImportable).toBe(1);
    expect(result.data.profiles.schema1.normalizationCounts).toEqual({});
  });

  it("discovers unsafe content after an early unsupported construct", async () => {
    const root = await fixture({ "later.svg": svg('<symbol id="unsupported"><path d="M0 0L1 1"/></symbol><script>seed-secret</script>') });
    const result = await analyze({ input: root });
    expect(result.status).toBe("error"); expect(result.exitCode).toBe(1);
    expect(result.files[0]?.profiles.commonV03.classification).toBe("unsafe");
    expect(result.files[0]?.profiles.commonV03.diagnosticCodes).toContain("ANALYZE_UNSAFE_ACTIVE_ELEMENT");
    expect(result.files[0]?.profiles.commonV03.diagnosticCodes).toContain("ANALYZE_UNSUPPORTED_ELEMENT");
  });

  it("does not treat active-looking text inside comments as an active element", async () => {
    const result = await analyze({ input: await fixture({ "comment.svg": svg('<!-- <script>seed</script> --><path d="M0 0L1 1"/>') }) });
    expect(result.files[0]?.profiles.commonV03.diagnosticCodes).not.toContain("ANALYZE_UNSAFE_ACTIVE_ELEMENT");
    expect(result.files[0]?.profiles.commonV03.featureCodes).toContain("xml.comment");
  });

  it.each([
    ["title only", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Title</title><path d="M0 0L1 1"/></svg>', "title_only_to_labelled"],
    ["unlabelled", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L1 1"/></svg>', "accessibility_authority_required"],
    ["decorative", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0L1 1"/></svg>', "declare_decorative"],
  ])("reports %s accessibility authority without inventing text", async (_label, source, normalization) => {
    const result = await analyze({ input: await fixture({ "a.svg": source }) });
    expect(result.files[0]?.profiles.commonV03.normalizations).toContain(normalization);
    if (_label === "decorative") expect(result.files[0]?.profiles.commonV03.normalizations).not.toContain("promote_root_presentation");
  });

  it("reports conflicting hidden labels as unsupported accessibility without destroying authored title", async () => {
    const result = await analyze({ input: await fixture({ "a.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-hidden="true"><title>Title</title><path d="M0 0L1 1"/></svg>' }) });
    expect(result.files[0]?.profiles.commonV03.classification).toBe("unsupported");
    expect(result.files[0]?.profiles.commonV03.diagnosticCodes).toContain("ANALYZE_INVALID_ACCESSIBILITY");
  });

  it("accepts all six primitives, currentColor presentation, rotate/scale/translate, and mixed groups", async () => {
    const body = '<g transform="translate(1 2) scale(2) rotate(45)"><circle r="1"/><ellipse rx="1" ry="2"/><rect width="2" height="3"/><line/><polyline points="0 0 1 1"/><polygon points="0 0 1 1 2 0"/></g>';
    const result = await analyze({ input: await fixture({ "geometry.svg": svg(body, ' fill="currentColor"') }) });
    expect(result.files[0]?.profiles.commonV03.classification).toBe("importable_with_normalization");
    for (const code of ["element.circle", "element.ellipse", "element.rect", "element.line", "element.polyline", "element.polygon", "paint.currentColor", "transform.rotate", "transform.scale", "transform.translate"]) expect(result.files[0]?.profiles.commonV03.featureCodes).toContain(code);
  });

  it.each([
    ["matrix transform", svg('<path transform="matrix(1 0 0 1 0 0)" d="M0 0L1 1"/>'), "ANALYZE_UNSUPPORTED_TRANSFORM"],
    ["invalid transform arity", svg('<path transform="rotate(1 2)" d="M0 0L1 1"/>'), "ANALYZE_UNSUPPORTED_TRANSFORM"],
    ["invalid opacity", svg('<path opacity="2" d="M0 0L1 1"/>'), "ANALYZE_INVALID_GEOMETRY"],
    ["empty path", svg('<path d=""/>'), "ANALYZE_INVALID_PATH_DATA"],
    ["unknown namespace", svg('<foo:path xmlns:foo="urn:seed" d="M0 0L1 1"/>'), "ANALYZE_UNSUPPORTED_NAMESPACE"],
    ["symbol", svg('<symbol id="s"><path d="M0 0L1 1"/></symbol>'), "ANALYZE_UNSUPPORTED_ELEMENT"],
    ["CDATA", svg('<metadata><![CDATA[seed]]></metadata><path d="M0 0L1 1"/>'), "ANALYZE_UNSUPPORTED_XML_NODE"],
    ["PI", svg('<?seed processing?><path d="M0 0L1 1"/>'), "ANALYZE_UNSUPPORTED_XML_NODE"],
  ])("maps %s to its closed public diagnostic", async (_label, source, code) => {
    const result = await analyze({ input: await fixture({ "a.svg": source }) });
    expect(result.files[0]?.profiles.commonV03.diagnosticCodes).toContain(code);
  });

  it.each([
    ["doctype", '<!DOCTYPE svg [<!ENTITY x "seed">]><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', "ANALYZE_UNSAFE_XML_DECLARATION"],
    ["style element", svg('<style>.x{fill:red}</style><path d="M0 0L1 1"/>'), "ANALYZE_UNSAFE_ACTIVE_ELEMENT"],
    ["event", svg('<path onclick="seed()" d="M0 0L1 1"/>'), "ANALYZE_UNSAFE_ACTIVE_ATTRIBUTE"],
    ["external", svg('<use href="https://example.invalid/seed.svg#x"/>'), "ANALYZE_UNSAFE_EXTERNAL_REFERENCE"],
    ["data", svg('<image href="data:image/png;base64,seed"/>'), "ANALYZE_UNSAFE_EXTERNAL_REFERENCE"],
  ])("classifies %s as unsafe", async (_label, source, code) => {
    const result = await analyze({ input: await fixture({ "a.svg": source }) });
    expect(result.files[0]?.profiles.commonV03.classification).toBe("unsafe");
    expect(result.files[0]?.profiles.commonV03.diagnosticCodes).toContain(code);
  });

  it("classifies local xlink as normalization and invalid local targets as unsupported", async () => {
    const source = svg('<defs><path id="p" d="M0 0L1 1"/></defs><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#p"/>');
    const result = await analyze({ input: await fixture({ "a.svg": source }) });
    expect(result.files[0]?.profiles.commonV03.normalizations).toEqual(expect.arrayContaining(["xlink_href_to_href", "xlink_namespace_to_svg2_href"]));
    expect(result.files[0]?.profiles.commonV03.diagnosticCodes).not.toContain("ANALYZE_INVALID_REFERENCE");
  });

  it.each([
    ["artwork target", svg('<path id="outside" d="M0 0L1 1"/><use href="#outside"/>')],
    ["non-definition target", svg('<defs><clipPath id="clip"><path d="M0 0L1 1"/></clipPath></defs><use href="#clip"/>')],
    ["reference cycle", svg('<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs><use href="#a"/>')],
    ["paint target", svg('<defs><path id="paint" d="M0 0L1 1"/></defs><path fill="url(#paint)" d="M0 0L1 1"/>')],
  ])("rejects %s reference authority", async (_label, source) => {
    const result = await analyze({ input: await fixture({ "reference.svg": source }) });
    expect(result.files[0]?.profiles.commonV03.diagnosticCodes).toContain("ANALYZE_INVALID_REFERENCE");
  });

  it.each([
    ["missing viewBox", '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>', "ANALYZE_INVALID_VIEWBOX"],
    ["invalid root", '<html xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></html>', "ANALYZE_INVALID_ROOT"],
    ["missing artwork", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>T</title></svg>', "ANALYZE_MISSING_ARTWORK"],
    ["invalid canvas", '<svg xmlns="http://www.w3.org/2000/svg" width="0" viewBox="0 0 1 1"><path d="M0 0L1 1"/></svg>', "ANALYZE_INVALID_CANVAS_DIMENSION"],
    ["invalid shape rendering", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" shape-rendering="seed"><path d="M0 0L1 1"/></svg>', "ANALYZE_INVALID_SHAPE_RENDERING"],
    ["unsupported root ID", '<svg xmlns="http://www.w3.org/2000/svg" id="seed" viewBox="0 0 1 1"><path d="M0 0L1 1"/></svg>', "ANALYZE_UNSUPPORTED_ATTRIBUTE"],
    ["unsupported SVG version", '<svg xmlns="http://www.w3.org/2000/svg" version="2.0" viewBox="0 0 1 1"><path d="M0 0L1 1"/></svg>', "ANALYZE_UNSUPPORTED_VERSION"],
  ])("reports %s", async (_label, source, code) => {
    const result = await analyze({ input: await fixture({ "invalid.svg": source }) }); expect(result.files[0]?.profiles.commonV03.diagnosticCodes).toContain(code);
  });

  it("reports malformed XML and invalid UTF-8 without leaking parser text", async () => {
    const root = await fixture({ "malformed.svg": '<svg xmlns="http://www.w3.org/2000/svg"><path></svg>', "utf8.svg": Uint8Array.from([0x3c, 0x73, 0x76, 0x67, 0x3e, 0xff, 0x3c, 0x2f, 0x73, 0x76, 0x67, 0x3e]) });
    const result = await analyze({ input: root });
    expect(result.files.find((file) => file.path === "malformed.svg")?.profiles.commonV03.diagnosticCodes).toContain("ANALYZE_SYNTAX_ERROR");
    expect(result.files.find((file) => file.path === "utf8.svg")?.profiles.commonV03.diagnosticCodes).toContain("ANALYZE_INVALID_UTF8");
  });

  it("distinguishes canonical XML 1.0, omitted declarations, unsafe XML 1.1, and SVG version normalization", async () => {
    const root = await fixture({
      "canonical.svg": svg('<path d="M0 0L1 1"/>'),
      "omitted.svg": svg('<path d="M0 0L1 1"/>').replace(/^<\?xml[^\n]+\n/, ""),
      "xml11.svg": svg('<path d="M0 0L1 1"/>').replace('version="1.0"', 'version="1.1"'),
      "svg10.svg": svg('<path d="M0 0L1 1"/>', ' version="1.0"'),
      "svg11.svg": svg('<path d="M0 0L1 1"/>', ' version="1.1"'),
    });
    const result = await analyze({ input: root });
    expect(result.files.find((file) => file.path === "canonical.svg")?.profiles.commonV03.diagnosticCodes).not.toContain("ANALYZE_UNSAFE_XML_DECLARATION");
    expect(result.files.find((file) => file.path === "omitted.svg")?.profiles.commonV03.diagnosticCodes).not.toContain("ANALYZE_UNSAFE_XML_DECLARATION");
    expect(result.files.find((file) => file.path === "xml11.svg")?.profiles.commonV03.diagnosticCodes).toContain("ANALYZE_UNSAFE_XML_DECLARATION");
    for (const path of ["svg10.svg", "svg11.svg"]) expect(result.files.find((file) => file.path === path)?.profiles.commonV03.normalizations).toContain("canonicalize_svg_version");
  });

  it("enforces modeled-element and group-depth boundaries at one over", async () => {
    const modeled = await analyze({ input: await fixture({ "exact.svg": svg('<path d="M0 0L1 1"/>'.repeat(1_024)), "over.svg": svg('<path d="M0 0L1 1"/>'.repeat(1_025)) }) });
    expect(modeled.files.find((file) => file.path === "exact.svg")?.profiles.commonV03.diagnosticCodes).not.toContain("ANALYZE_PROFILE_ELEMENT_LIMIT_EXCEEDED");
    expect(modeled.files.find((file) => file.path === "over.svg")?.profiles.commonV03.diagnosticCodes).toContain("ANALYZE_PROFILE_ELEMENT_LIMIT_EXCEEDED");
    const nested = (depth: number) => `${'<g>'.repeat(depth)}<path d="M0 0L1 1"/>${'</g>'.repeat(depth)}`;
    const exact = await analyze({ input: await fixture({ "exact.svg": svg(nested(8)) }) }); const over = await analyze({ input: await fixture({ "over.svg": svg(nested(9)) }) });
    expect(exact.files[0]?.profiles.commonV03.diagnosticCodes).not.toContain("ANALYZE_PROFILE_DEPTH_LIMIT_EXCEEDED"); expect(over.files[0]?.profiles.commonV03.diagnosticCodes).toContain("ANALYZE_PROFILE_DEPTH_LIMIT_EXCEEDED");
  });

  it("caps samples at 20 while retaining complete per-code file counts and exact omission text", async () => {
    const files = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`${String(index).padStart(2, "0")}.svg`, svg('<symbol/><path d="M0 0L1 1"/>')]));
    const result = await analyze({ input: await fixture(files) });
    expect(result.data.profiles.commonV03.diagnosticCounts.ANALYZE_UNSUPPORTED_ELEMENT).toBe(21); expect(result.data.samples.commonV03.ANALYZE_UNSUPPORTED_ELEMENT).toHaveLength(20);
    expect(renderAnalyzeHuman(result)).toContain("20 displayed, 1 omitted");
  });

  it("keeps aggregate JSON and NDJSON deterministic across creation order", async () => {
    const first = await fixture({ "z.svg": svg('<path d="M0 0L1 1"/>'), "a.svg": svg('<path d="M0 0L1 1"/>') });
    const second = await fixture({ "a.svg": svg('<path d="M0 0L1 1"/>'), "z.svg": svg('<path d="M0 0L1 1"/>') });
    const left = await analyze({ input: first }); const right = await analyze({ input: second });
    expect(JSON.stringify(createAnalyzeEnvelope(left))).toBe(JSON.stringify(createAnalyzeEnvelope(right)));
    expect(serializeAnalyzeDetailsLines(left)).toEqual(serializeAnalyzeDetailsLines(right));
  });

  it("keeps the checked-in unsupported-clipping JSON and NDJSON examples executable", async () => {
    const example = await readFile(join(process.cwd(), "docs/examples/v0.3/unsupported-clipping.svg"));
    const result = await analyze({ input: await fixture({ "unsupported-clipping.svg": example }) });
    expect(serializeJsonEnvelope(createAnalyzeEnvelope(result))).toBe(await readFile(join(process.cwd(), "docs/examples/v0.3/unsupported-clipping.analyze.json"), "utf8"));
    expect(serializeAnalyzeDetailsLines(result).join("")).toBe(await readFile(join(process.cwd(), "docs/examples/v0.3/unsupported-clipping.analyze.ndjson"), "utf8"));
  });

  it("does not leak source text, path data, absolute roots, stacks, or environment markers", async () => {
    const secret = "TFSB_SECRET_TITLE_91d2"; const data = "M91.123 82.456L73.789 64.321";
    const root = await fixture({ "secret.svg": svg(`<path d="${data}"/>`).replace("seed-title", secret) });
    const result = await analyze({ input: root });
    const reports = JSON.stringify(createAnalyzeEnvelope(result)) + serializeAnalyzeDetailsLines(result).join("") + renderAnalyzeHuman(result);
    for (const forbidden of [secret, data, root, "process.env", " at "]) expect(reports).not.toContain(forbidden);
    expect(await readFile(join(root, "secret.svg"), "utf8")).toContain(secret);
  });

  it("continues through EOF after the per-file byte limit and lets later unsafe dominate", async () => {
    const prefix = `<svg xmlns="http://www.w3.org/2000/svg">${"<!--x-->".repeat(1_250_000)}`;
    const result = await analyze({ input: await fixture({ "large.svg": `${prefix}<script/></svg>` }) });
    expect(result.files[0]?.profiles.commonV03.diagnosticCodes).toEqual(expect.arrayContaining(["ANALYZE_FILE_BYTE_LIMIT_EXCEEDED", "ANALYZE_UNSAFE_ACTIVE_ELEMENT"]));
    expect(result.status).toBe("error");
  });

  it("accurately remaps real schema-1 diagnostic codes onto closed analyze diagnostic codes without misrouting", async () => {
    const root = await fixture({
      "bad-gradient-units.svg": svg('<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1" gradientUnits="userSpace"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><path fill="url(#g)" d="M0 0L1 1"/>'),
      "bad-stop-color.svg": svg('<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><path fill="url(#g)" d="M0 0L1 1"/>'),
      "shorthand-hex.svg": svg('<path fill="#f00" d="M0 0L1 1"/>'),
    });
    const result = await analyze({ input: root });
    const bg = result.files.find((f) => f.path === "bad-gradient-units.svg");
    const bs = result.files.find((f) => f.path === "bad-stop-color.svg");
    const sh = result.files.find((f) => f.path === "shorthand-hex.svg");

    expect(bg?.profiles.schema1.classification).toBe("unsupported");
    expect(bg?.profiles.schema1.diagnosticCodes).toEqual(["ANALYZE_INVALID_GEOMETRY"]);

    expect(bs?.profiles.schema1.classification).toBe("unsupported");
    expect(bs?.profiles.schema1.diagnosticCodes).toEqual(["ANALYZE_UNSUPPORTED_PAINT"]);

    expect(sh?.profiles.schema1.classification).toBe("unsupported");
    expect(sh?.profiles.schema1.diagnosticCodes).toEqual(["ANALYZE_UNSUPPORTED_PAINT"]);
  });

  it("emits reachable definition.basic_geometry, definition.group, definition.path, and paint.external feature codes", async () => {
    const root = await fixture({
      "defs-features.svg": svg('<defs><circle id="c" r="1"/><g id="grp"><path d="M0 0L1 1"/></g><path id="p" d="M0 0L1 1"/></defs><use href="#grp"/><path fill="url(https://example.invalid/ext.svg#paint)" d="M0 0L1 1"/>'),
    });
    const result = await analyze({ input: root });
    const file = result.files[0];
    expect(file?.profiles.commonV03.featureCodes).toEqual(expect.arrayContaining([
      "definition.basic_geometry",
      "definition.group",
      "definition.path",
      "paint.external",
    ]));
  });

  it("keeps schema-1 diagnosticCodes derived purely from schema-1 parser without inheriting commonV03 diagnostics", async () => {
    const root = await fixture({
      "primitive-circle.svg": svg('<circle cx="5" cy="5" r="3"/>'),
    });
    const result = await analyze({ input: root });
    const file = result.files[0];
    expect(file?.profiles.commonV03.classification).toBe("directly_importable");
    expect(file?.profiles.schema1.classification).toBe("unsupported");
    expect(file?.profiles.schema1.diagnosticCodes).toEqual(["ANALYZE_UNSUPPORTED_ELEMENT"]);
    expect(file?.profiles.commonV03.diagnosticCodes).toEqual([]);
  });
});


