# Vector scene v1 contract candidate

Status: unreleased TFSB61A checkpoint. Package metadata remains 0.4.0.
This is not a public 0.5 release or release candidate.

## Identity and API

The installed ESM subpath is `@knowledge-forge-ai/theme-forge-stellar-burst/scene/v1`.
`validateScene`, `inspectScene`, `canonicalizeScene` and `compileScene` accept plain
JSON data and return the repository's `{ok,value}` / `{ok:false,diagnostics}` union.
Schema `tfsb.vector-scene-v1`, compatibility 1 and compiler level 1 are independent
of package SemVer. Receipts use `tfsb.scene-compile-receipt-v1` and bind canonical
source/SVG, token/provenance snapshots, artboard/profile, catalog and limits.
Timing, host paths and package patch version are excluded from receipt identity.

A document's `compilerLevel` is its minimum required semantic compiler level.
The compiler accepts positive integer levels up to its supported level, preserves
the authored requirement in canonical source, and records the actual compiler
level in receipts. Compatibility remains an exact schema gate. A future compatible
compiler must keep accepting level-1 documents; changed output requires new
evidence even when the source remains compatible.

`scene.schema.json` describes structural JSON. Runtime validation additionally
checks graph references, cycles, finite arithmetic, byte/expansion limits and
layout feasibility. Runtime validation is required; JSON Schema alone is not an
acceptance gate. Inventory hashes bind the supplied schemas and examples.

## Geometry and composition

Painter order is authored element order. Groups inherit paint and multiply
opacity; child paint overrides inheritance. Symbols are local only. Their explicit
viewBox maps into each use viewport with `xMidYMid meet`, clipped at the viewport.
Bounds are the mapped union of child boxes; missing path boxes prevent use/group
layout. Primitive boxes exclude stroke. Labels use fixed cell bounds. Paths need
explicit bounds when used by layout or anchors; no curve-bounds engine is implied.

Layout targets/references must be top-level elements. Align, distribute and grid
use painter order for ties and placement; anchor references are resolved after
topological ordering. Two directives writing one element axis are rejected.
Connector anchors address siblings in the same group/symbol coordinate space;
cross-scope anchors are rejected. Orthogonal connectors require explicitly
axis-aligned waypoints (or a directly aligned pair). Zero-length route segments
and straight connectors with waypoints are rejected. Triangle/chevron arrowheads
lower to ordinary paths; there is no automatic routing or graph layout.

Column-vector transforms `[A,B]` mean `A * B * point`. Rotation about a center is
`T(center) * R(angle) * T(-center)`. Intermediate non-finite arithmetic fails.
Compiler level 1 reduces rotation degrees modulo 360 to the nearest quadrant,
evaluates sine/cosine with 12 fixed binary64 Taylor recurrence steps on
`[-pi/4,pi/4]` using `pi = 3.141592653589793`, then applies the quadrant signs.
Quadrants are exact. Arrow directions use scale normalization followed by eight
Newton steps from 1 for the square root on `[1,2]`; focal validity uses normalized
squared distance. These calculations do not call host sin/cos/sqrt/hypot.
Numbers use existing finite binary64 shortest-round-trip decimal spelling,
expanded from exponent notation, with negative zero normalized and no additional
rounding. Validated path operands receive the same spelling; arc flags remain
single digits. Output attributes have fixed order; gradients then symbols are
ordered by ID; artwork is never sorted. UTF-8 output uses LF and one final LF.

Artboards retain numeric dimensions/viewBox. Presets resolve hero 1440x720,
section 960x360, diagram 1200x675, figure 960x540 and social 1200x630. `contain`
centers spare viewport area (`xMidYMid meet`); `pad` aligns it at top-left
(`xMinYMin meet`). Neither crops authored root geometry by changing viewBox.

Paint is none/currentColor/hex/token/local-gradient only. Token values are hex
snapshots or `token:name` aliases; aliases resolve to a canonical hex snapshot.
Names use `[A-Za-z_][A-Za-z0-9_.-]*`; only own bindings resolve, including names
that coincide with JavaScript prototype properties. Missing and cyclic aliases
fail. Gradients use objectBoundingBox or userSpaceOnUse,
monotonic stops and pad spread. A zero-sized object bounding box has no painted
object-bounding-box gradient under SVG semantics. No arbitrary stylesheet exists.

## Labels, accessibility and provenance

Forge Grid Label v1 was authored as original first-party integer M/L/Z geometry
for this implementation, without font import, tracing or third-party artwork.
The catalog includes all 95 printable ASCII characters, fixed 6-unit advance,
10-unit line/cell height and 1-unit stroke baseline. There is no kerning or shaping.
LF is the canonical newline; unsupported characters fail. Semantic strings remain
in scenes and are attached accessibly to their lowered geometry. Authored root
descriptions are preserved; an omitted description stays omitted. SVG contains geometry,
not text/tspan. Catalog identity includes glyph data and metrics; see inventory.
Expression is AGPL-3.0-or-later with separately available commercial terms.

Labelled scenes produce escaped title/description and collision-free ARIA IDs.
Decorative scenes reject root accessibility title/desc and focusable=true, and emit hidden presentation
semantics. Provenance is a bounded closed record; no arbitrary XML or private
absolute paths are accepted. Scene semantics may contain ordinary human text;
callers remain responsible for not authoring secrets into visible labels.

## Limits and file boundary

`inventory.json` records exact code-level limits. Additional bounded output
policies reject canonical paths over 1 MiB, aggregate canonical paths over 16 MiB,
and conservative SVG estimates/output over 32 MiB. Conservative output accounting
may reject a scene whose actual compact SVG would be smaller. There is no bypass.

CLI: `tfsb scene validate|inspect <scene.json> [--json]` and
`tfsb scene compile <scene.json> --output <absent.svg> [--dry-run] [--json]`.
Input is a bounded regular-file snapshot. Dry-run writes nothing. Output must be
absent; there is no overwrite option. Existing symlink parents and final-component
symlinks are rejected. Publication writes and syncs complete staged bytes before
an exclusive hard-link commit. It never replaces an existing target. Failures
before commit attempt owned staging cleanup; failures after commit retain the complete
target and report cleanup state.

As with the existing path-based transaction engine, output directories must remain
under the caller's control during publication. Parent-component checks detect
observed replacements but cannot exclude a concurrent replacement between checks
and filesystem calls. This API does not claim handle-relative confinement against
a process that can rename its ancestors. No native publication ABI is introduced.

Clips, masks, external-asset snapshots and raster vendoring are deferred. General
text, images, filters, arbitrary XML/CSS/JS, animation and external resources are
rejected. Examples are original first-party compositions, not dogfood copies.
