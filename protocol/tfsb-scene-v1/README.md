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
`tfsb scene compile <scene.json> --output <absent.svg> [--palette <colors.json>] [--dry-run] [--json]`.
The optional palette overrides declared color tokens during compilation. It
accepts a JSON object of existing token names and six-digit `#RRGGBB` colors.
The source must validate before overrides are applied. The compilation receipt
binds the effective scene and resolved colors after applying the palette.
See the [editable character example](../../docs/art/vector/README.md).

To change a path's shape while keeping the editable scene, use
`tfsb scene revise <scene.json> --edits <edits.json> --output <absent-scene.json>`.
The edits file is a nonempty array of objects containing an existing path
element's `id` and its new SVG path string `d`. For the illustration example,
save this as `edits.json`.

```json
[{ "id": "flightVector", "d": "M 100 620 C 400 650 800 460 1300 420" }]
```

Revision supports paths inside groups and symbol definitions. It validates the
original scene, rejects repeated or unknown IDs and invalid geometry, and writes
canonical scene JSON to a new file. If expanded path spacing exceeds the scene
file size limit, revision uses compact path spacing. The JSON result reports the output SHA-256
in both `--dry-run` and write mode. Compile the revised scene to export its SVG.

To add a foreground layer, supply an edits file containing
`{"appendGroup":{"type":"group","id":"tablet","children":[...]}}` to the same
revision command. It appends exactly one nonempty named group above the scene's
existing elements. Use unique IDs for the group and any paths you want to revise.
The complete result must pass the existing scene validation and file limits.
This operation does not extract regions from the existing paths.

Use `tfsb scene trace-png source.png --output traced.scene.json` to trace an
existing opaque illustration. Supply a metadata-free, noninterlaced 8-bit
RGB or RGBA PNG of at most 4,194,304 pixels. For a WebP reference, decode it
to PNG before invoking the tracer. Then run
`tfsb scene compile traced.scene.json --output traced.svg --compact-paths`.

To start from a static sRGB WebP, use
`tfsb scene trace-webp source.webp --native-detail --output traced.scene.json`.
It uses the existing optional ImageMagick capability to decode a WebP with
the source dimensions and no resize. The source must meet the closed WebP
header policy and the tracing limits. Animated, metadata-bearing and
oversized files are refused. Use `--preserve-alpha` for transparent artwork.
The JSON result binds the input WebP hash, decoded PNG digest, decode recipe,
and written scene hash. The editor scene can then be compiled to SVG and
exported with `scene export-webp`.

High-detail tracing is the default for both input commands. On sufficiently large
inputs, it subdivides cells at color transitions on a finer grid to retain
thin strokes. It uses up to 1,152 detail colors with a separate 96-color
underpaint. The default trace uses a 12 MB SVG budget, with earlier
high-detail settings and the regular trace available when it exceeds the byte
or contour limits. Illustration scenes
admit up to 2,600,000 path segments within the usual per-path and input limits.

Use `--regular` to select the smaller trace for ordinary display sizes. The
regular trace samples each cell by exact pixel coverage and uses a palette of
up to 448 colors, with a separate 96-color underpaint to reduce seams. If it
exceeds a contour limit, it tries the earlier 256-color and 160-color traces.

`--compact-paths` removes optional spacing from SVG path data and preserves
the geometry and scene digest. The SVG contains no raster image. Regions are
grouped by paint color. Review the export at its intended display size.

Use `--native-detail` to prioritize the native raster delivery size for complex
artwork. It attempts a finer grid with up to 1,536 cells on the long edge
without upsampling the source. The first pass can split a cell into rows,
columns, or four samples depending on the mean RGB error of each option.
Finer color bins preserve small differences before quantization to up to
1,664 detail colors. Images that exceed the earlier palette search’s bin
count limit fall back to six-bit bins. The densest trace uses SVG’s implicit fill closure to reserve more of the budget
for detail. Its subpaths are open for stroking and closed for filling. When
a native trace exceeds the 16 MB SVG budget, 8 MiB scene file limit, or
contour limits, the tracer tries earlier native-detail settings before high
detail and the regular trace. Use high detail for intermediate display widths
where its grid better matches the intended scale.

For local retouching, `trace-png --native-detail --exclude-detail polygon.json`
omits detail cells inside a strictly convex clockwise polygon of three to eight
whole-pixel vertices, in source coordinates with Y increasing down. The native
grid must match the source dimensions. The tracer selects its preset on the
original image and keeps its palette, base, and underpaint. The cut reveals
that underpaint and leaves editable vector contours. Add a named foreground
group with `scene revise` to replace the removed detail. Keep the source PNG,
polygon, scene JSON, and reviewed SVG together to reproduce the edit.

The Cloe visual test uses the released WebP as its fixed reference, traces
a PNG decoded from those bytes, and renders the compiled SVG in Chromium
and WebKit. The regular trace is checked at 256, 336, 384 and 512 CSS pixels.
The high-detail trace is checked at 512, 768 and 1024 CSS pixels. The native-detail
trace is checked at 512 and 1024 CSS pixels. It checks mean absolute
RGB channel error in the whole image, face and tablet, and limits the
fraction of pixels with any channel error above 48. The browser-specific
tolerances account for differences in downsampling. The uncompressed SVG
must stay below 16,000,000 bytes.

Use `tfsb scene rasterize traced.scene.json --output traced.png --json`
with the qualified resvg companion to produce PNG from the same compiled SVG
at the scene's artboard dimensions. The renderer accepts up to 16,000,000 SVG
bytes. Use the same palette and path options as `scene compile` when matching
an existing SVG's digest. Pass `--expect-svg-digest sha256:<64 lowercase hex digits>`
using the compile receipt's `svgDigest`. A mismatch stops before rendering
or writing a PNG. The raster receipt binds the SVG digest to the PNG digest.

Use `scene rasterize reviewed.svg --svg-source --expect-svg-digest <digest>
--output reviewed.png --json` to render a reviewed SVG file without a scene JSON
input. The reader admits at most 16,000,000 bytes. It verifies a bounded file
snapshot, checks the expected digest, and admits only exact canonical output of
the current compiler. Pass `--compact-paths` if the reviewed SVG was compiled
with that option. The validation compiler runs against an internal scene
projection. The renderer receives the original file bytes. Palette overrides
apply only when compiling a scene JSON input. To prepare an authored external
SVG, use the existing import and compile workflow, then review the emitted
canonical SVG and record its digest. The maintained illustration exporter
can encode the PNG as WebP with a source-bound recipe.

To reopen the same reviewed SVG as an editable scene, use
`scene import-svg reviewed.svg --svg-source --expect-svg-digest <digest>
--output reopened.scene.json --json`. Supply `--compact-paths` for a compact
reviewed SVG. The command preserves named paths and groups, records the exact
input digest, and keeps dense path data compact in the 8 MiB editable scene.
Compiling that scene with the same path option reproduces the reviewed SVG
byte-for-byte until an edit changes its geometry. The review option admits
only canonical compiler output. Other authored SVG goes through the normal
import route.

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
