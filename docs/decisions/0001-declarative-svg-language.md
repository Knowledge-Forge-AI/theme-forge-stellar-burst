# ADR 0001: Project Manifest Plus Human-Oriented Asset TOML

- Status: Accepted
- Date: 2026-08-21
- Scope: declarative language shape and supported SVG profile

## Context

TFSB needs a canonical representation that an ordinary developer can understand and edit without mentally reconstructing an XML AST. It must import the real Terminal Nova favicon, mark, monochrome marks, and lockups; preserve their meaningful structure; serialize deterministically; and reject everything outside an intentionally small SVG profile.

The Terminal Nova evidence is not toy geometry. The horizontal and stacked lockups contain a linear gradient, a reusable mark group, thirteen path glyph definitions, transformed `<use>` sequences, stroked open paths, accessibility text, free-form `<metadata>`, and SVG2 gradient fallback paint. The favicon and mark use grouped facets and multiline path data. Any selected syntax must make those assets readable rather than merely possible.

## Decision drivers

- Hand editing and code review must be easier than SVG XML.
- Artwork hierarchy and order must remain visible.
- Paths must remain recognizable SVG `d` strings.
- Shared build/install policy must not be duplicated per asset.
- Import must map into a closed typed model without arbitrary tag/attribute bags.
- Errors should identify one file, TOML path, and offending value.
- Serialization and schema evolution must be deterministic.
- The design must stay small enough for a modest TypeScript CLI.

## Alternatives

### A. One project file and one file per asset (selected)

```text
.tfsb/project.toml
.tfsb/assets/favicon.toml
.tfsb/assets/mark.toml
.tfsb/assets/lockup-horizontal.toml
```

The project file owns the generated directory and all install destinations. Each asset file owns one canvas, accessibility block, text metadata, definitions, and ordered artwork. The language uses a closed set of fields and element variants with compact, typed path/use lists.

### B. Self-contained per-asset files

Each asset file would contain its output directory and destinations as well as artwork:

```toml
id = "favicon"
filename = "favicon.svg"
build_directory = "brand/dist"
destinations = ["docs/public/favicon.svg", "docs/public/favicon-on-light.svg"]
```

This makes one asset portable in isolation, but repeats project policy across every file. A build-directory change touches all assets, destination collision checks have no natural overview, and code review mixes geometry with deployment.

### C. One monolithic project TOML

One file would contain project policy and every asset as nested arrays of tables. This centralizes validation and avoids cross-file discovery, but the real lockups make the file long, conflict-prone, and difficult to review. Error line numbers are local but human attention is not.

## Comparison

| Criterion | A. Project + asset files | B. Self-contained assets | C. Monolith |
| --- | --- | --- | --- |
| Hand-editability | High: one focused artwork file | Medium: deployment noise in every file | Low once several real assets coexist |
| Visual correspondence | High: ordered defs and artwork are adjacent | High for geometry, diluted by placement | Medium: asset boundaries are nested in a large file |
| Repetition/noise | Low; only asset schema repeats | High for build and install policy | Low syntactically, high navigationally |
| Shared installation state | One explicit project view | Duplicated and collision-prone | One explicit project view |
| Importability | Direct one-SVG-to-one-file mapping | Direct mapping plus policy synthesis | Requires coordinated rewrite of one large file |
| Deterministic serialization | Straightforward per file and asset | Straightforward but repeated policy normalization | Straightforward but broad diffs |
| Schema evolution | Project and asset schemas share version 1 | Policy evolution touches all assets | One schema but costly migrations/diffs |
| Error locality | File plus TOML path | File plus TOML path | TOML path only within a large file |
| Code review | Geometry change stays isolated | Geometry and placement are coupled | High conflict and diff noise |
| Understand nontrivial asset without XML reconstruction | Yes; the lockup reads as defs plus three lettering groups | Yes, but with unrelated placement data | Possible, but requires navigating the aggregate |

## Decision

Select alternative A. `.tfsb/project.toml` owns project name, generated directory, and zero-or-more installation destinations. `.tfsb/assets/<id>.toml` owns one generated SVG filename and its complete declarative artwork.

The asset language is not an XML AST. There is no arbitrary `tag`, attribute map, namespace map, raw child array, or catch-all extension node. `type = "path" | "group" | "use"` is a closed discriminant whose allowed named fields are statically known. Groups have ordered compact `paths` or `uses` bodies in v0.1; they are not generic mixed-content containers.

Repeated glyph definitions in horizontal and stacked lockups are accepted intentionally. Cross-asset includes would reduce repetition but introduce source ownership, parameterization, and review-indirection costs that the fixture set does not justify.

## Human-oriented syntax rules

- SVG path data stays in `d` strings. Multiline TOML strings are allowed; no proprietary path commands are introduced.
- Familiar SVG values stay recognizable: `view_box`, transforms, colors, local `href`, stroke joins/caps, and gradient coordinates.
- Common group bodies use arrays of compact path/use records rather than repeated XML-like node tables.
- Artwork geometry and placement never share a table.
- Free-form SVG metadata is `metadata_text`, a multiline string—not a lossy attempt to infer key/value records.
- Gradient fallback paint is split into `fill` and `fill_fallback` so both values are obvious and typed; SVG serialization recombines them.
- Unknown keys fail. Comments in TOML are for humans and are not semantic state.

## Supported SVG profile

### Document structure

The importer accepts XML 1.0 UTF-8 SVG documents with one SVG-namespace `<svg>` root. An optional leading UTF-8 BOM is accepted before either the root or optional XML declaration. DOCTYPE, entity declarations, processing instructions other than the XML declaration, and non-SVG namespace content are rejected. XML comments are accepted and discarded as non-semantic.

Supported root attributes are:

- `xmlns` (normalized to the canonical SVG namespace);
- positive unitless `width` and `height`;
- four-number `viewBox` with positive extent;
- `role="img"`;
- `aria-labelledby` resolving to the declared title and description IDs in that order;
- `shape-rendering` with the closed values represented by the model.

Exactly one `<title>` and one `<desc>` are required in v0.1. Each has an ID and text-only content. One optional `<metadata>` is supported with no attributes or child elements. Metadata import converts CRLF/CR to LF, removes leading/trailing blank lines, removes the common indentation prefix from nonblank lines, and preserves all remaining characters and line breaks. The serializer applies canonical indentation; normalized metadata text participates in structural equality.

### Definitions

One optional `<defs>` may contain:

- `<linearGradient>` with `id`, `x1`, `y1`, `x2`, `y2`, optional `gradientUnits`, and two or more `<stop>` children;
- named `<path>` definitions;
- named `<g>` definitions containing only supported paths in v0.1.

Gradient units are `userSpaceOnUse` or `objectBoundingBox`. Explicit `objectBoundingBox` and omission are the same default domain value and serialize without `gradientUnits`; `userSpaceOnUse` remains explicit. Stops support numeric/percentage offsets normalized to `[0,1]`, hex `stop-color`, and optional `[0,1]` `stop-opacity`. Hex colors canonicalize to uppercase `#RRGGBB`. IDs are asset-local and unique. Cross-category definition order is non-semantic in this closed profile and canonicalizes to linear gradients, groups, then paths; order within each category is preserved.

### Artwork

Root artwork is an ordered sequence of:

- `<path>` with optional `id`, `fill`, gradient fallback, stroke fields, and supported transform;
- `<use>` with local `href`, optional `id`, `x`, `y`, presentation fields, and supported transform;
- `<g>` with optional `id`, presentation fields, supported transform, and an ordered body consisting solely of supported paths or solely of supported uses.

Presentation fields are `fill`, `fill_fallback`, `stroke`, `stroke_fallback`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, and `stroke-miterlimit`. v0.1 paints are `none`, supported hex colors, or local `url(#id)` gradient paint. SVG input may use the two-token fallback form `url(#id) #RRGGBB` for fill or stroke; TOML stores the second token as `fill_fallback` or `stroke_fallback`, and canonical output emits one separating space (`fill="url(#id) #RRGGBB"` / `stroke="url(#id) #RRGGBB"`). External URLs and data URLs fail.

Transforms are ordered `translate` and `scale` operations only. The Terminal Nova fixture does not require matrix, rotate, or skew, so they remain unsupported rather than being admitted speculatively.

### Explicit exclusions

The following fail at import or TOML validation: scripts and event handlers; external links/resources; `<image>` and embedded raster data; `<foreignObject>`; animation; text/fonts; `<style>` and `style` attributes; external CSS; filters; masks; clipping paths; markers; patterns; radial gradients; symbols; arbitrary namespaces; unknown elements/attributes; and nested or mixed-content groups beyond the v0.1 group bodies.

No raw-XML escape hatch exists in v0.1. A future escape hatch would require a new ADR proving a concrete production need, a safe closed representation, deterministic serialization, and explicit visual/semantic tests.

## Canonicalization boundary

Canonicalization may change XML declaration/BOM presence, whitespace, indentation, attribute order, quote style, namespace redundancy, self-closing syntax, comments, cross-category definition order, equivalent numeric spelling, and hex-color case. Optional attributes matching their SVG default (`shape-rendering="auto"`, `gradientUnits="objectBoundingBox"`, and `x="0"` / `y="0"` on `<use>`) are canonically omitted. Canonicalization may not change root artwork order, order within a definition category or group body, geometry semantics, path commands, transform order, IDs/references, accessibility text, metadata text after defined normalization, paint/fallback, or gradient stop order. TOML title, description, and metadata strings undergo the same text normalization as imported XML.

Canonical numeric SVG output uses non-exponent decimal form, normalizes `-0` to `0`, adds a leading zero to fractions, and removes insignificant trailing zeros. Path data is validated with SVG command-aware argument grammar, including compact adjacent elliptical-arc flags, and whitespace-normalized but not re-encoded into a proprietary path model. The complete round-trip and visual contracts are defined in the architecture document.

## Consequences

### Benefits

- The real favicon and mark read as canvas, gradient, facet paths, and nova rather than XML scaffolding.
- The lockup's reusable mark and glyph paths remain visible, while repeated element tags, namespaces, and quote noise disappear.
- Placement policy has one reviewable home and supports multiple destinations naturally.
- Closed variants give TypeScript exhaustive checking and precise diagnostics.
- Refusing generic preservation prevents active/unsupported content from slipping through import.

### Costs

- v0.1 intentionally rejects valid SVG outside its profile.
- Re-import into an existing project, mixed/nested groups, and cross-asset definitions require future decisions.
- Metadata markup cannot round-trip; only text-only metadata is supported.
- Horizontal and stacked asset files duplicate path glyph definitions.
- Import needs a safe XML parser and TOML codec; their exact packages require dependency review in the implementation phase.

## Verification

The checked-in examples are derived from the real fixture values, including complete metadata text, fallback fills, transforms, stroke attributes, gradient stops, and glyph path data. Implementation acceptance requires all six fixtures—not only the three examples—to normalize and round-trip structurally, plus deterministic SVG bytes and the later bounded Playwright comparisons described by the architecture.
