import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";

import {
  ASSET_DIGEST_BASIS_V2,
  buildProject,
  bundleProject,
  checkProject,
  computeAssetSemanticDigest,
  diffProject,
  formatProject,
  importProject,
  installProject,
  listProject,
  loadCanonicalProject,
  parseAssetTomlV2,
  parseSvg,
  parseSvgV2,
  previewProject,
  reconcileProject,
  serializeAssetTomlV2,
  serializeSvgV2,
} from "../src/index.js";
import { validateSvgDocumentV2 } from "../src/schema2-validation.js";
import { DiagnosticError } from "../src/diagnostics.js";
import type { ArtworkElementV2, SvgDocumentV2 } from "../src/schema2-types.js";
import { firstCode, makeTempDir, readRepoFile, unwrap } from "./helpers.js";

const COMPREHENSIVE_TOML = `schema_version = 2
id = "schema-two"
filename = "schema-two.svg"

[canvas]
width = 32
height = 24
view_box = "0 0 32 24"
shape_rendering = "geometricPrecision"

[accessibility]
mode = "labelled"
title = "Schema two"
description = "Closed typed geometry"
focusable = false

[presentation]
fill = "none"
stroke = "currentColor"
stroke_width = 2
stroke_linecap = "round"
stroke_linejoin = "bevel"
stroke_miterlimit = 2
opacity = 0.8
fill_opacity = 0.7
stroke_opacity = 0.6
fill_rule = "evenodd"
clip_rule = "nonzero"

[[definitions.linear_gradients]]
id = "paint-b"
x1 = 0
y1 = 0
x2 = 1
y2 = 1
stops = [
  { offset = 0, color = "#000000" },
  { offset = 1, color = "#FFFFFF", opacity = 0.5 },
]

[[definitions.paths]]
type = "path"
id = "path-z"
d = "M0 0L1 1"

[[definitions.groups]]
type = "group"
id = "group-a"
children = [
  { type = "use", reference = "path-z", x = 1, y = 2 },
  { type = "circle", cx = 3, cy = 4, r = 2 },
]

[[definitions.circles]]
type = "circle"
id = "circle-c"
cx = 4
cy = 4
r = 3

[[elements]]
type = "group"
aria_hidden = false
fill_gradient = "paint-b"
fill_fallback = "#123456"
transforms = [
  { type = "translate", x = 2 },
  { type = "rotate", angle = 45, cx = 8, cy = 8 },
  { type = "scale", x = 0.5 },
]
children = [
  { type = "path", d = "M0 0L8 8" },
  { type = "use", reference = "group-a", x = 2, y = 3 },
  { type = "circle", cx = 4, cy = 4, r = 3 },
  { type = "ellipse", cx = 8, cy = 4, rx = 3, ry = 2 },
  { type = "rect", x = 1, y = 1, width = 8, height = 6, corner_radius = 2 },
  { type = "rect", x = 10, y = 1, width = 8, height = 6, corner_radii = [2, 1] },
  { type = "line", x1 = 0, y1 = 0, x2 = 8, y2 = 8 },
  { type = "polyline", points = [[0, 0], [1, 1]] },
  { type = "polygon", points = [[0, 0], [2, 0], [1, 2]] },
]
`;

describe("schema-2 closed core", () => {
  it("round-trips deterministic TOML, SVG, and v2 digest bytes", () => {
    const asset = unwrap(parseAssetTomlV2(COMPREHENSIVE_TOML));
    expect(asset.svg.accessibility).toMatchObject({
      mode: "labelled",
      titleId: "tfsb-schema-two-title",
      descriptionId: "tfsb-schema-two-description",
    });
    const firstToml = serializeAssetTomlV2(asset);
    const secondAsset = unwrap(parseAssetTomlV2(firstToml));
    const secondToml = serializeAssetTomlV2(secondAsset);
    expect(secondAsset).toEqual(asset);
    expect(secondToml).toBe(firstToml);
    expect(firstToml.endsWith("\n")).toBe(true);
    expect(firstToml.endsWith("\n\n")).toBe(false);

    const firstSvg = unwrap(serializeSvgV2(asset.svg));
    const secondSvg = unwrap(serializeSvgV2(unwrap(parseSvgV2(firstSvg))));
    expect(secondSvg).toBe(firstSvg);
    expect(firstSvg).toContain('stroke="currentColor"');
    expect(firstSvg).toContain('<rect x="10" y="1" width="8" height="6" rx="2" ry="1"/>');
    expect(firstSvg).toContain('transform="translate(2) rotate(45 8 8) scale(0.5)"');
    expect(ASSET_DIGEST_BASIS_V2).toBe("tfsb-asset-toml-v2");
    expect(computeAssetSemanticDigest(asset)).toBe("sha256:098d4a57f5b1bb4196c6b4cb5c0d18dd2e7db47effc8f1ea322661044180bd39");
    expect(computeAssetSemanticDigest(secondAsset)).toBe(computeAssetSemanticDigest(asset));
  });

  it.each([
    ["labelled", '[role="img"]', "Schema two"],
    ["decorative", '[aria-hidden="true"]', undefined],
    ["consumer_labelled", '[role="img"]', undefined],
  ] as const)("emits exact %s accessibility intent", (mode, rootFragment, title) => {
    const source = mode === "labelled"
      ? COMPREHENSIVE_TOML
      : COMPREHENSIVE_TOML.replace('mode = "labelled"\ntitle = "Schema two"\ndescription = "Closed typed geometry"', `mode = "${mode}"`);
    const svg = unwrap(serializeSvgV2(unwrap(parseAssetTomlV2(source)).svg));
    expect(svg).toContain(rootFragment.slice(1, -1));
    expect(svg.includes("<title")).toBe(title !== undefined);
    if (mode === "decorative") expect(svg).not.toContain('role="img"');
    if (mode === "consumer_labelled") expect(svg).not.toContain("aria-labelledby");
  });

  it.each([
    ["unknown root key", COMPREHENSIVE_TOML.replace('filename = "schema-two.svg"', 'filename = "schema-two.svg"\nraw_xml = "<g/>"'), "SCHEMA_UNKNOWN_KEY"],
    ["named color", COMPREHENSIVE_TOML.replace('fill = "none"', 'fill = "red"'), "SCHEMA_INVALID_COLOR"],
    ["CSS function", COMPREHENSIVE_TOML.replace('fill = "none"', 'fill = "rgb(0 0 0)"'), "SCHEMA_INVALID_COLOR"],
    ["root aria_hidden", COMPREHENSIVE_TOML.replace('fill = "none"', 'aria_hidden = true\nfill = "none"'), "SCHEMA_UNKNOWN_KEY"],
    ["partial rotate pivot", COMPREHENSIVE_TOML.replace('cx = 8, cy = 8', 'cx = 8'), "SCHEMA_INVALID_TRANSFORM"],
    ["invalid circle", COMPREHENSIVE_TOML.replace('cx = 4, cy = 4, r = 3', 'cx = 4, cy = 4, r = 0'), "SCHEMA_INVALID_RANGE"],
    ["malformed polyline", COMPREHENSIVE_TOML.replace('points = [[0, 0], [1, 1]]', 'points = [[0, 0]]'), "SCHEMA_INVALID_RANGE"],
    ["unresolved use", COMPREHENSIVE_TOML.replace('reference = "group-a"', 'reference = "outside"'), "REFERENCE_UNRESOLVED"],
  ])("rejects %s", (_name, source, code) => {
    expect(firstCode(parseAssetTomlV2(source))).toBe(code);
  });

  it.each([
    ["style", '<path style="fill:red" d="M0 0L1 1"/>', "XML_ACTIVE_CONTENT"],
    ["event", '<path onclick="x()" d="M0 0L1 1"/>', "XML_ACTIVE_CONTENT"],
    ["radial gradient", "<radialGradient/>", "XML_UNSUPPORTED_ELEMENT"],
    ["clip path", "<clipPath/>", "XML_UNSUPPORTED_ELEMENT"],
    ["mask", "<mask/>", "XML_UNSUPPORTED_ELEMENT"],
    ["filter", "<filter/>", "XML_UNSUPPORTED_ELEMENT"],
    ["marker", "<marker/>", "XML_UNSUPPORTED_ELEMENT"],
    ["pattern", "<pattern/>", "XML_UNSUPPORTED_ELEMENT"],
    ["symbol", "<symbol/>", "XML_UNSUPPORTED_ELEMENT"],
    ["text", "<text>x</text>", "XML_UNSUPPORTED_ELEMENT"],
    ["image", '<image href="https://example.invalid/x"/>', "XML_ACTIVE_CONTENT"],
    ["matrix", '<path transform="matrix(1 0 0 1 0 0)" d="M0 0L1 1"/>', "XML_INVALID_TRANSFORM"],
    ["skew", '<path transform="skewX(2)" d="M0 0L1 1"/>', "XML_INVALID_TRANSFORM"],
  ])("rejects unsupported SVG %s", (_name, body, code) => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" aria-hidden="true">\n  ${body}\n</svg>\n`;
    expect(firstCode(parseSvgV2(source))).toBe(code);
  });

  it("enforces group depth eight and total modeled elements 1,024", () => {
    const leaf: ArtworkElementV2 = { type: "path", d: "M0 0L1 1" as never };
    let atLimit: ArtworkElementV2 = leaf;
    for (let depth = 0; depth < 8; depth += 1) atLimit = { type: "group", children: [atLimit] };
    const base = unwrap(parseAssetTomlV2(COMPREHENSIVE_TOML));
    const depthSvg: SvgDocumentV2 = { ...base.svg, definitions: { linearGradients: [], groups: [], paths: [], circles: [], ellipses: [], rects: [], lines: [], polylines: [], polygons: [] }, elements: [atLimit] };
    expect(() => validateSvgDocumentV2(depthSvg, { operation: "validate", domain: "svg" })).not.toThrow();
    expect(() => validateSvgDocumentV2({ ...depthSvg, elements: [{ type: "group", children: [atLimit] }] }, { operation: "validate", domain: "svg" })).toThrowError(DiagnosticError);
    const exactly = Array.from({ length: 1_024 }, () => leaf);
    expect(() => validateSvgDocumentV2({ ...depthSvg, elements: exactly }, { operation: "validate", domain: "svg" })).not.toThrow();
    expect(() => validateSvgDocumentV2({ ...depthSvg, elements: [...exactly, leaf] }, { operation: "validate", domain: "svg" })).toThrowError(DiagnosticError);
  });

  it("keeps the frozen schema-1 writer byte-identical through the schema-2 writer boundary", () => {
    const golden = readRepoFile("docs/examples/v0.3/schema-1-ordering-golden.svg");
    const schema1 = unwrap(parseSvg(golden));
    expect(unwrap(serializeSvgV2(schema1))).toBe(golden);
  });

  it("rejects a mixed project before publishing outputs", async () => {
    const root = makeTempDir("tfsb-schema2-mixed-");
    mkdirSync(join(root, ".tfsb/assets"), { recursive: true });
    writeFileSync(join(root, ".tfsb/project.toml"), 'schema_version = 2\nname = "mixed"\n\n[build]\ndirectory = "brand/dist"\n');
    writeFileSync(join(root, ".tfsb/assets/schema-two.toml"), COMPREHENSIVE_TOML.replace("schema_version = 2", "schema_version = 1"));
    await expect(loadCanonicalProject(root, "build")).rejects.toMatchObject({ diagnostic: { code: "SCHEMA_PROJECT_VERSION_MISMATCH" } });
  });

  it("qualifies schema-2 build/install/check/list/bundle/fmt/diff/preview and paired reconcile", async () => {
    const root = makeTempDir("tfsb-schema2-lifecycle-");
    mkdirSync(join(root, ".tfsb/assets"), { recursive: true });
    mkdirSync(join(root, "installed"), { recursive: true });
    const projectToml = `schema_version = 2\nname = "schema-two"\n\n[build]\ndirectory = "brand/dist"\n\n[[install]]\nasset = "schema-two"\ndestinations = [\n  "installed/schema-two.svg",\n]\n`;
    const asset = unwrap(parseAssetTomlV2(COMPREHENSIVE_TOML));
    const assetToml = serializeAssetTomlV2(asset);
    writeFileSync(join(root, ".tfsb/project.toml"), projectToml);
    writeFileSync(join(root, ".tfsb/assets/schema-two.toml"), `\n${assetToml}`);

    expect((await formatProject({ root, check: true })).changed).toBe(true);
    expect((await formatProject({ root })).applied).toBe(true);
    expect(readFileSync(join(root, ".tfsb/assets/schema-two.toml"), "utf8")).toBe(assetToml);
    await buildProject(root);
    await installProject(root);
    const checked = await checkProject(root);
    expect(checked.build).toMatchObject({ missing: [], different: [] });
    expect(checked.install).toMatchObject({ missing: [], different: [] });
    expect((await listProject(root)).assets).toHaveLength(1);
    const bundle = await bundleProject({ root, output: "schema-two.zip" });
    expect(bundle.entries.some((entry) => entry.name === "schema-two.svg")).toBe(true);
    const preview = await previewProject({ root });
    expect(preview.assets).toHaveLength(1);
    expect(readFileSync(join(root, ".tfsb-preview/assets/schema-two.svg"), "utf8")).toBe(unwrap(serializeSvgV2(asset.svg)));

    const changedSvg = unwrap(serializeSvgV2({
      ...asset.svg,
      elements: asset.svg.elements.map((element, index) =>
        index === 0 && element.type === "group"
          ? { ...element, children: element.children.map((child, childIndex) => childIndex === 2 && child.type === "circle" ? { ...child, r: 4 } : child) }
          : element,
      ),
    }));
    const archive = join(root, "baseline.zip");
    writeFileSync(archive, Buffer.from(zipSync({ "schema-two.svg": new TextEncoder().encode(changedSvg) })));
    const semantic = await diffProject({ root, baseline: "archive", archive });
    expect(semantic.baseline).toBe("archive");
    if (semantic.baseline === "archive") expect(semantic.changes.some((change) => change.location.includes(".r"))).toBe(true);
    expect(await diffProject({ root, baseline: "provenance" })).toMatchObject({ baseline: "provenance", different: true, records: [{ key: "asset:schema-two", relation: "untracked_current_record" }] });
    expect(await reconcileProject({ root, archive })).toMatchObject({ blocked: true, applied: false, records: [{ key: "asset:schema-two", classification: "CONFLICT" }] });
  });

  it("defaults new direct import to schema 2, honors schema 1, and refuses already initialized roots", async () => {
    const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml")));
    const canonicalSvg = unwrap(serializeSvgV2(asset.svg));
    const firstArchive = join(makeTempDir("tfsb-schema2-import-archive-"), "first.zip");
    writeFileSync(firstArchive, Buffer.from(zipSync({ "synthetic-orbit.svg": new TextEncoder().encode(canonicalSvg) })));
    const root = makeTempDir("tfsb-schema2-import-");
    const first = await importProject({ archive: firstArchive, root });
    expect(first.project.schemaVersion).toBe(2);
    expect(readFileSync(join(root, ".tfsb/project.toml"), "utf8")).toContain("schema_version = 2");

    await expect(importProject({ archive: firstArchive, root })).rejects.toMatchObject({ diagnostic: { code: "ROOT_ALREADY_INITIALIZED" } });

    const schema1Root = makeTempDir("tfsb-schema1-import-");
    const schema1Archive = join(makeTempDir("tfsb-schema1-import-archive-"), "schema1.zip");
    writeFileSync(schema1Archive, Buffer.from(zipSync({ "ordering.svg": new TextEncoder().encode(readRepoFile("docs/examples/v0.3/schema-1-ordering-golden.svg")) })));
    expect((await importProject({ archive: schema1Archive, root: schema1Root, schema: 1 })).project.schemaVersion).toBe(1);
    await expect(importProject({ archive: schema1Archive, root: schema1Root })).rejects.toMatchObject({ diagnostic: { code: "ROOT_ALREADY_INITIALIZED" } });
  });

  it("rejects unowned normalization while allowing truthful schema-2 provenance recording", async () => {
    const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml")));
    const canonical = unwrap(serializeSvgV2(asset.svg));
    const nonCanonicalSvg = `${canonical}\n`;
    const normalizedArchive = join(makeTempDir("tfsb-schema2-normalize-"), "source.zip");
    writeFileSync(normalizedArchive, Buffer.from(zipSync({ "synthetic-orbit.svg": new TextEncoder().encode(nonCanonicalSvg) })));
    const normalizeRoot = makeTempDir("tfsb-schema2-normalize-root-");
    await expect(importProject({ archive: normalizedArchive, root: normalizeRoot })).rejects.toMatchObject({ diagnostic: { code: "IMPORT_NORMALIZATION_REQUIRED" } });
    expect(() => readFileSync(join(normalizeRoot, ".tfsb/project.toml"))).toThrow();

    const canonicalArchive = join(makeTempDir("tfsb-schema2-provenance-archive-"), "canonical.zip");
    writeFileSync(canonicalArchive, Buffer.from(zipSync({ "synthetic-orbit.svg": new TextEncoder().encode(canonical) })));
    const provenanceRoot = makeTempDir("tfsb-schema2-provenance-root-");
    await expect(importProject({ archive: canonicalArchive, root: provenanceRoot, recordProvenance: true })).resolves.toMatchObject({ project: { schemaVersion: 2 } });
    expect(readFileSync(join(provenanceRoot, ".tfsb/provenance.json"), "utf8")).toContain('"schemaVersion": 2');
  });

  it("directly imports canonical schema-2 SVGs with root presentation", async () => {
    const asset = unwrap(parseAssetTomlV2(readRepoFile("docs/examples/v0.3/lucide-consumer-labelled.toml")));
    const canonicalSvg = unwrap(serializeSvgV2(asset.svg));
    const archive = join(makeTempDir("tfsb-schema2-direct-archive-"), "direct.zip");
    writeFileSync(archive, Buffer.from(zipSync({ "synthetic-orbit.svg": new TextEncoder().encode(canonicalSvg) })));
    const root = makeTempDir("tfsb-schema2-direct-root-");
    const result = await importProject({ archive, root });
    expect(result.project.schemaVersion).toBe(2);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.svg).toEqual(asset.svg);
  });
});
