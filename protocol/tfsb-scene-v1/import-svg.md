# Safe SVG import into scene v1

This additive API belongs to the private unreleased scene implementation. Package
metadata remains 0.4.0; it does not imply that the published 0.4.0 release includes
these commands. Scene compatibility and compiler level remain 1.

```sh
tfsb scene import-svg input.svg --output imported.scene.json --json
tfsb scene validate imported.scene.json --json
tfsb scene compile imported.scene.json --output compiled.svg --json
```

Both output paths must be absent. Inputs are bounded regular-file snapshots;
symlinks and observed replacement are rejected. Callers must control parent
directories throughout publication, as with existing scene compilation.

```js
import { sceneImportSvg, compileScene } from
  '@knowledge-forge-ai/theme-forge-stellar-burst/scene/v1';

const result = sceneImportSvg(new TextEncoder().encode(svgSource));
if (result.classification === 'SUPPORTED_IMPORT') {
  const compiled = compileScene(result.scene);
  // result.canonicalScene contains deterministic, validated scene JSON.
}
```

The API takes bytes, with no filesystem or network authority. Results include a
`sha256:` source digest, parsed feature observations and completeness, stable
reason codes, and explicit normalization codes. Only `SUPPORTED_IMPORT` includes
a scene. Repeat import and compilation are deterministic; source-byte roundtrip
is not promised.

## Equivalence and supported subset

The contract preserves supported standalone SVG painting, painter order and group
compositing under scene numeric canonicalization. It does not preserve host CSS,
DOM identity, selectors, interaction, or arbitrary XML. Source viewBox is retained.
Missing width/height are explicitly normalized to viewBox extents; unitless and
px dimensions are accepted. Only default `xMidYMid meet` aspect-ratio semantics
are supported. CurrentColor remains dependent on the consuming color context.

Supported primitives are path, rect/rounded rect, circle, ellipse, line, polyline,
polygon and ordered groups. Group/root presentation inheritance and child
overrides remain SVG inheritance; group opacity stays on the group. Transforms
are ordered translate, scale, rotate (including centers), and matrix operations.
Fill/stroke, opacity, fill/clip rules and the supported stroke properties map to
scene presentation. Colors support three/six-digit hex, fully opaque four/eight-
digit hex, a closed basic-name table, and integral rgb/opaque rgba forms. Other
alpha colors and unsupported syntax fail explicitly.

Linear/radial gradients support local references, pad spread and ordered bounded
stops. Object-bounding-box percentages lower to fractions. User-space gradients
require explicit unitless/px coordinates; viewport-dependent percentage/default
coordinates are unsupported. Gradient transforms and reference inheritance are
unsupported. Local use targets must be symbols in root defs, with explicit
viewBox and instance width/height. Reference graphs are validated before expansion.

Duplicate IDs fail. Source IDs are mapped deterministically into the scene ID
grammar; references use the same map. Generated geometry IDs avoid every authored
ID. The emitter allocates title/description IDs around that namespace.

A root title produces labelled accessibility; otherwise import explicitly chooses
decorative accessibility. Accepted description, focusability and root ARIA
references are canonicalized. Conflicts or unsupported accessibility semantics
fail import. Ordinary text/tspan never becomes Forge Grid Label.

## Rejections and limits

Script/events, foreignObject, external resources, animation, DTDs and entities are
rejected. UTF-8 and XML parsing are fatal. No external entity/resource resolution
is available. CSS stylesheets, inline style and classes are unsupported; their
mere presence is analyze-only, not evidence of active unsafe content. Unknown
namespaces/tags/attributes and unsupported value semantics fail explicitly.
Clips, masks, text, filters, images, markers and arbitrary metadata are not imported.

One terminal classification is returned: `SUPPORTED_IMPORT`,
`SUPPORTED_ANALYZE_ONLY`, `DEFERRED_TIER2`, `REJECTED_UNSAFE`,
`REJECTED_OUT_OF_SCOPE`, or `INVALID_INPUT`. All observed bounded reasons are
retained. Observed unsafe authority takes precedence over deferred features.
Early encoding/XML/resource rejection can leave feature observation incomplete;
missing observations are not zero counts. Missing viewBox is an unsupported
input contract, not malformed XML.

Input and canonical scene JSON are capped at 8 MiB. Before DOM construction,
XML is capped at depth 128, 100,000 structural nodes (including text/comment
runs), 64 attributes per element and 100,000 total attributes. Existing scene
ceilings additionally govern authored/expanded elements, local/reference depth,
paths, points, transforms, definitions, gradient stops and output bytes. There
is no unlimited import mode. No unsupported content is published as a partial scene.

## Corpus qualification

The TFSB62A source-owned classifier reads recorded Git blobs, including supplemental
SVGs, without modifying dogfood checkouts. Complete per-file evidence is retained
externally; repository evaluations carry aggregate counts, exact report digest,
record count and bounded examples. Original synthetic fixtures freeze imported
semantics. Sampled raster comparisons qualify only their selected inputs and
renderer tuple, not whole-corpus pixel equivalence or third-party redistribution.
