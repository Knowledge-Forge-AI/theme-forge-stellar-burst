# TFSB32 — Schema-2 Core

## Objective

Implement schema-2 core exactly as specified by
[v0.3 architecture](../architecture/v0.3.md) and
[ADR 0005](../decisions/0005-schema-2-accessibility-and-presentation.md),
while preserving every released schema-1 behavior.

This phase owns homogeneous schema-version dispatch; schema-2 asset/project
TOML parsing and canonical writing; the closed schema-2 accessibility,
presentation, geometry, group, transform, definition, and local-reference
model; SVG parse/write; semantic diff; formatting; preview; and existing
lifecycle command compatibility. It does not own migration, provenance schema
2, import normalization, normalization maps, directory collection workflows,
or release work.

## Authority and starting state

1. Work only in the dispatcher-selected TFSB development checkout.
2. Fetch refs/tags, require a clean worktree, and verify the live semantic base
   contains the accepted v0.2.0 lifecycle, committed TFSB31 analyzer, and
   reviewed TFSB31R1 baseline. Historical SHAs are evidence, not a substitute
   for live semantic checks.
3. Verify package version remains `0.2.0`; do not publish, tag, or change the
   released v0.2.0 surface.
4. Run `npm ci`, `npm run typecheck`, `npm test`, `npm audit --omit=dev`,
   `npm run test:visual`, and `npm pack --dry-run --json` before editing.
5. Stop on material starting-state divergence. Do not rebase, reset, rewrite,
   migrate a live project, or guess.

## Required schema dispatch

- Parse the project `schema_version` before asset decoding and select exactly
  one versioned project/asset parser and writer.
- A project is homogeneous. Every asset must declare the same supported schema
  version as the project. Mixed, missing, or unsupported versions fail before
  lifecycle planning or writes with the architecture-owned version diagnostic,
  including `SCHEMA_PROJECT_VERSION_MISMATCH` for mixed projects.
- Preserve the schema origin as a discriminant through validation. Lifecycle
  planners consume a validated common interface; version branching belongs at
  parser/writer/digest boundaries rather than being scattered through command
  logic.
- Ordinary `import`, `build`, `install`, `check`, `list`, `reconcile`, `diff`,
  `fmt`, `bundle`, and `preview` never migrate or normalize a project.

## Frozen schema-1 contract

Schema 1 remains readable, writable, buildable, installable, checkable,
listable, reconcilable, diffable, formattable, previewable, and bundleable.
Do not reinterpret its TOML, normalized model, SVG bytes, digest basis,
diagnostics, ordering, or command behavior.

Required frozen evidence includes the complete existing schema-1
unit/integration/visual suite plus migration-order goldens even though migration
itself belongs to TFSB33:

1. shared schema-1 path serialization is byte-unchanged;
2. shared schema-1 use serialization is exact, including `id`, `href`, `x`,
   `y`, presentation, and transform order;
3. shared definition category order and within-kind source order are exact;
4. shared group presentation/transform/child order is exact;
5. every shared root/accessibility attribute combination is exact; and
6. `tfsb-asset-toml-v1` remains the same basis over the same canonical bytes.

The existing TFSB30R1 ordering source/golden is required evidence, not a
schema-2 migration implementation.

## Schema-2 TOML and normalized model

Add closed schema-2 project and asset decoders, validators, canonical writers,
and discriminated normalized types. Unknown tables, keys, enum values,
unmodeled element kinds, invalid numeric values, and invalid combinations fail
closed. Do not add raw XML, arbitrary attributes, generic element records, or
unchecked schema unions.

Canonical schema-2 asset TOML must be deterministic and end with one LF. Freeze
`tfsb-asset-toml-v2` as SHA-256 over those exact UTF-8 bytes. It is independent
of the frozen v1 basis and of `tfsb-svg-output-v1`. This phase may compute and
consume the v2 canonical digest in ordinary schema-2 lifecycle operations; it
must not add migration or provenance-transition records.

## Accessibility

Implement exactly one schema-2 mode per asset:

- `labelled`: non-empty title, optional description, deterministic generated
  IDs by default, and optional focusability;
- `decorative`: no title/description, root `aria-hidden="true"`, and optional
  focusability; or
- `consumer_labelled`: no title/description, root `role="img"`, no
  `aria-hidden`, `aria-label`, or `aria-labelledby`, and optional focusability.

Default generated IDs are `tfsb-<asset-id>-title` and
`tfsb-<asset-id>-description`. Explicit IDs must satisfy the accepted ID
grammar, remain locally unique, and be used only for exact preservation.
Filenames and asset IDs never become accessible prose. Do not infer decorative
or consumer authority and do not implement source normalization.

## Presentation and paint

Add schema-2 root `[presentation]` and the same closed overrides on supported
groups/elements:

- fill and stroke;
- stroke width, line cap, line join, and miter limit;
- opacity, fill opacity, and stroke opacity; and
- fill rule and clip rule.

Preserve schema-1 canvas `shape_rendering`, element/group `aria_hidden`, and
gradient fallback fields. Paint is exactly `none`, six-digit hex,
`currentColor`, or a typed local linear-gradient reference with optional typed
fallback. Do not add arbitrary color syntax or a root `color` value.

Fill, stroke, stroke geometry, fill/stroke opacity, fill rule, and clip rule
inherit. Element values override inherited values. `opacity` composites at the
declared node and is not inherited. Parser, writer, semantic diff, preview, and
tests must preserve that distinction.

## Geometry and groups

Implement first-class circle, ellipse, rect, line, polyline, and polygon
records. Preserve primitive identity through parse, canonical TOML, SVG write,
format, diff, build, bundle, and preview; never flatten them to paths.

- Rect supports `corner_radius` for equal radii and
  `corner_radii = [rx, ry]` for unequal radii.
- Polyline/polygon points are typed numeric pairs.
- Groups contain a typed ordered `children` array of supported paths, uses,
  primitives, and groups.
- Group nesting is limited to eight levels and each asset to 1,024 modeled
  elements. Reject one-over cases before output.
- Mixed and nested groups preserve normalized child order. There is no generic
  element record.

## Transforms, definitions, and references

- Implement ordered typed translate, scale, and rotate transforms. Rotate
  accepts an angle alone or angle with a complete pivot.
- Reject matrix, skewX, skewY, malformed arguments, unsupported arity, and
  arbitrary transform text.
- Keep `<use>` asset-local. SVG 2 `href` is canonical.
- Model local typed definitions for linear gradients, paths, groups, and the
  six basic primitives. References must resolve to an allowed definition type;
  unresolved, cross-asset, external, or cyclic references fail closed.
- Emit definitions before artwork. Emit shared linear gradients, definition
  groups, then definition paths exactly as frozen for schema 1. Schema-2-only
  definition primitives follow the shared categories. Preserve normalized
  within-kind array order; never sort definitions by ID.
- Preserve the exact shared path/use/group field order from ADR 0005. A generic
  presentation helper must not reorder `<use>`.

Do not implement xlink-to-href normalization. A schema-2 canonical model may
read only the exact accepted source forms owned by this phase; import
normalization and its ledger remain TFSB33.

## SVG parser and writer

Add schema-2 SVG parsing/writing only for the closed model above. Reuse or
delegate shared rendering to frozen schema-1 helpers where doing so preserves
exact schema-1 output.

Schema-2 root serialization order is: `xmlns`, width/height, `viewBox`,
accessibility attributes, `focusable`, `shape-rendering`, then schema-2 root
presentation. Do not emit an extra SVG `version` attribute. Shared and
schema-2-only presentation ordering follows ADR 0005 exactly.

Every accepted schema-2 source must round-trip to one deterministic normalized
model and canonical TOML/SVG. Every unsupported or unsafe row fails as a whole
asset; no partial model or raw escape hatch is allowed.

## Existing command compatibility

Extend the existing version-dispatched lifecycle without creating new mutation
authority:

- `build`, `install`, `check`, `list`, and `bundle` operate on a homogeneous
  validated schema-2 project under existing confinement, transaction, receipt,
  collision, and 128-asset limits;
- `fmt` uses the selected version's canonical writer and never changes schema;
- `diff` compares shared schema-1 and schema-2 semantics through typed common
  locations, reports new schema-2 presentation/geometry/transform locations,
  and does not flatten primitives;
- `preview` renders static schema-2 projects with exact accessibility and
  presentation behavior under the existing output-safety model; and
- bundle/build/install/check/list result schemas and command exit semantics
  remain compatible unless the architecture explicitly versioned a field.

Schema-1 reconcile remains frozen. Schema-2 provenance and changed-source
reconcile belong to TFSB33; TFSB32 must neither claim schema-2 reconcile
support nor invent an interim provenance/reconciliation format.

Do not add `tfsb migrate`, import flags, normalization policy identity, or
provenance schema 2 while wiring these commands.

## Required accepted and unsupported coverage

Create table-driven product tests for every accepted and unsupported row in
ADR 0005, including interactions rather than only isolated field presence.

Accepted coverage includes:

1. all three accessibility modes, generated/explicit IDs, focusability, and
   exact root output;
2. every presentation field at root, group, and element scope, including
   inheritance/non-inheritance and numeric/enum boundaries;
3. `none`, six-digit hex, `currentColor`, and typed local linear-gradient paint
   with fallback;
4. all six primitives, both rect-corner forms, typed point pairs, and mixed
   path/use/primitive/group children;
5. group depth and modeled-element limits at the limit;
6. each translate/scale/rotate form and ordered transform lists;
7. each accepted definition kind, forward source ordering normalized to
   canonical category order, within-kind order preservation, valid local use,
   and definition-use graphs; and
8. deterministic schema-2 TOML/SVG/digest, semantic diff, format, preview,
   bundle, build, install, check, and list behavior, plus unchanged schema-1
   reconcile behavior.

Unsupported or invalid coverage includes:

1. missing/mixed/unknown schema versions and schema-1/v2 cross-writing;
2. conflicting accessibility modes, empty labels, invalid/duplicate IDs,
   fabricated accessible text, and forbidden accessibility attributes;
3. arbitrary CSS/XML, classes/styles/events, unsupported namespaces,
   untyped/invalid paint, color values, and invalid numeric/enum fields;
4. radial gradients, clipping, masks, filters, markers, patterns, symbols,
   text, arbitrary elements, and external resource-bearing content;
5. matrix/skew transforms, malformed arity/text, unresolved/type-invalid/local
   cycles, cross-asset/external references, and direct-root typed definitions;
6. group depth nine, modeled element 1,025, invalid primitive dimensions,
   invalid rect radii, and malformed point lists; and
7. any operation that would silently migrate, normalize, widen limits, or
   produce a partial schema-2 asset.

Synthetic fixtures own security, limit, interaction, and round-trip coverage.
Use the
[authoritative analyzer baseline](../evaluations/v0.3-analyzer-dogfood-baseline.md)
to choose representative feature families. External dogfood probes, if used,
remain local-only tracked-blob inputs and must not be copied into the
repository or treated as import acceptance shards.

## Non-goals

TFSB32 does not own and must not begin:

- `tfsb migrate`, schema-1-to-schema-2 conversion, migration transactions, or
  cross-basis migration checkpoints;
- provenance schema 2 or archive/migration reconciliation history;
- import `--normalize`, normalization execution, normalization maps, dry-run
  normalization ledgers, normalization-policy digests, or changed-source
  reconciliation normalization;
- directory import/reconcile, source maps, workspaces, collection identity,
  prefixes, curated-shard commands, or path-derived collection mapping;
- higher candidate/SVG/import/mutation/group/model limits;
- radial gradients, clipping, masks, filters, markers, patterns, symbols,
  arbitrary CSS/XML, or generic elements;
- dogfood import acceptance shards beyond bounded local parser/visual probes;
  or
- package versioning, public documentation/release polish, publication, tags,
  or v0.3 release work.

If implementing ordinary schema-2 parsing requires normalization authority,
if frozen schema-1 output changes, or if TFSB33 provenance/migration work cannot
remain separate, stop and return the material finding rather than absorbing it.

## Verification and completion

Run at minimum:

```sh
npm run typecheck
npm test
npm audit --omit=dev
npm run test:visual
npm pack --dry-run --json
```

Also prove:

- every ADR 0005 accepted/unsupported row has executable product evidence;
- all frozen schema-1 ordering and lifecycle evidence remains byte-exact;
- schema-2 canonical TOML/SVG and `tfsb-asset-toml-v2` are deterministic;
- homogeneous version rejection happens before writes;
- bundle/build/install/check/list/diff/fmt/preview preserve their existing
  transaction and result boundaries, while schema-1 reconcile stays frozen and
  schema-2 reconcile remains deferred;
- no migration, normalization, provenance-schema, collection, higher-limit,
  copied-dogfood, dependency, package-version, or package-payload drift occurs;
  and
- only intended production source ships in the package.

TFSB32 is complete when schema 2 is a closed, deterministic, lifecycle-capable
core language; schema 1 remains frozen; every ADR 0005 boundary has tests; and
all TFSB33 migration/normalization/provenance authority remains deferred.

Return a bounded candidate with exact test counts, schema-1 golden evidence,
schema-2 accepted/unsupported matrix coverage, digest vectors, lifecycle
results, visual coverage, package contents, and all deferrals. Publication and
stage transitions remain dispatcher-owned.
