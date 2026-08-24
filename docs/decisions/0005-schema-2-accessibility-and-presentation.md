# ADR 0005: Schema 2 Accessibility, Presentation, and Common Geometry

- Status: Proposed for v0.3 implementation
- Date: 2026-08-22
- Scope: asset schema versioning, accessibility authority, root presentation,
  common geometry, transforms, and local references
- Controlling architecture: [v0.3](../architecture/v0.3.md)
- Evidence: [v0.3 compatibility projection](../evaluations/v0.3-compatibility-projection.md)

## Context

Schema 1 deliberately requires a title, description, explicit IDs, and exact
`aria-labelledby`. It also has no document presentation and represents only
paths, restricted groups, and local uses. All 3,453 measured Simple Icons files
are title-only; the 6,184 individual Tabler outline/filled files and most
Lucide icons depend on root presentation, `currentColor`, and basic primitives.

Adding these capabilities to schema 1 would change the meaning of a released
closed language. The change is not a field rename: it introduces explicit
accessibility ownership, a typed presentation cascade, and new geometry unions.

## Alternatives

- Extend schema 1 in place. Rejected because it would make released schema-1
  bytes version-dependent and weaken the frozen digest contract.
- Flatten every primitive to path data. Rejected because it obscures author
  intent, makes semantic diff worse, and is not reversible.
- Store arbitrary XML attributes or CSS. Rejected because it turns TOML into
  an untyped escape hatch and can launder active content.
- **Add schema 2 while retaining frozen schema 1 (selected).**

## Decision

1. A schema-2 project and every asset in it declare `schema_version = 2`.
   Projects are homogeneous: schema-1 and schema-2 asset files cannot mix.
2. Schema 1 remains fully readable, buildable, installable, reconcilable,
   diffable, formattable, previewable, and bundleable in v0.3. Its parser,
   writer, SVG serialization, and `tfsb-asset-toml-v1` digest basis are frozen.
3. Version-specific TOML/SVG decoders produce one validated semantic model
   whose schema origin remains discriminated. Lifecycle planners consume the
   validated common interface; only parser/writer and migration boundaries
   dispatch on version.
4. Accessibility is exactly one of:
   - `labelled`: non-empty title, optional description, deterministic
     asset-prefixed IDs by default, and optional focusability;
   - `decorative`: no title/description, root `aria-hidden="true"`, and
     optional focusability; or
   - `consumer_labelled`: no title/description, root `role="img"`, no
     `aria-hidden`/`aria-label`/`aria-labelledby`, and optional focusability,
     with the host responsible for the accessible name.
5. Filenames and asset IDs never become accessible text. Missing source labels
   require explicit decorative or consumer authority. Title-only input may be
   normalized to `labelled` without fabricating a description.
6. Schema 2 preserves schema-1 canvas and element presentation fields:
   `[canvas] shape_rendering` (`auto` | `optimizeSpeed` | `crispEdges` |
   `geometricPrecision`), `aria_hidden` boolean on groups and elements, and
   `fill_fallback` / `stroke_fallback` for gradient fallback paint. Schema 2
   adds `[presentation]` for root/document presentation and the same closed
   override fields on groups/elements: fill, stroke, stroke width, line cap,
   line join, miter limit, opacity, fill opacity, stroke opacity, fill rule,
   and clip rule. Paint is limited to `none`, six-digit hex, `currentColor`, or
   a typed local linear-gradient reference (`fill_gradient` / `stroke_gradient`
   with optional `fill_fallback` / `stroke_fallback`). `color` is not added
   because the common-corpus evidence does not require a document value.
7. Fill, stroke, stroke geometry, fill/stroke opacity, fill rule, and clip rule
   inherit. Element values override inherited values. `opacity` is not
   inherited; it composites at its declared node, matching SVG behavior.
8. Circle, ellipse, rect, line, polyline, and polygon are first-class geometry.
   Rect uses `corner_radius` for equal radii or `corner_radii = [rx, ry]` for
   unequal radii. Point lists use typed numeric pairs. Primitives are never
   flattened during parse, format, migration, build, diff, or preview.
9. Schema-2 transforms are typed ordered records for translate, scale, and
   rotate. Rotate accepts either an angle alone or angle plus a complete pivot.
   Matrix, skewX, and skewY remain unsupported in v0.3.
10. `<use>` remains asset-local. SVG 2 `href` is canonical; local `xlink:href`
    may normalize to it. Definition paths, common shapes, and bounded groups
    may be referenced. References must resolve, cycles fail, definitions emit
    before artwork, and `<symbol>` remains unsupported.
11. Groups may contain a typed `children` array of supported elements to allow
    mixed and nested common geometry. Nesting is limited to eight levels and
    1,024 total modeled elements per asset. There is no generic element record.
12. The SVG serializer reuses or delegates shared rendering to the frozen
    schema-1 helpers. Root emits `xmlns`, width/height, `viewBox`, `role`,
    `aria-labelledby` / `aria-hidden`, `focusable`, `shape-rendering`, then
    schema-2 root presentation without an extra `version` attribute. Shared
    presentation remains `fill`, `stroke`, `stroke-width`, `stroke-linecap`,
    `stroke-linejoin`, `stroke-miterlimit`, `opacity`, `aria-hidden`;
    schema-2-only fill/stroke opacity and rule fields follow it. Shared path
    order is `id`, presentation, `transform`, `d`; shared use order is `id`,
    `href`, `x`, `y`, presentation, `transform`; shared group order is `id`,
    presentation, `transform`, children. A generic
    `id`/presentation/transform/geometry rule must not reorder `<use>`.
13. Shared definitions emit linear gradients, definition groups, then
    definition paths. Normalized array order is preserved within each kind;
    definitions are never sorted by ID. Shared gradients/stops retain exact
    schema-1 field and array order. Schema-2-only definition primitives follow
    the shared categories and preserve normalized array order. Import may
    record `canonicalize_definition_order` when source XML differs from this
    category model, but it preserves source-relative within-kind order in the
    resulting model.
14. Fresh schema-1 and migrated schema-2 SVG serialization must be byte-equal
    for every shared schema-1 asset. TFSB32 must exercise multiple deliberately
    non-ID-ordered gradients/groups/paths, a full-attribute `<use>`, shared
    group presentation/transform, and every shared root combination before
    TFSB33 may migrate. The TFSB30R1 synthetic golden freezes schema-1 behavior;
    it does not implement the schema-2 writer.

Default generated accessibility IDs are `tfsb-<asset-id>-title` and
`tfsb-<asset-id>-description`. They must be unique among local IDs. Explicit
IDs are accepted only when valid, locally unique, and needed for preservation.
Asset-prefixed IDs avoid collisions between different assets; consumers that
inline the same SVG more than once remain responsible for instance-level DOM
ID namespacing.

For `<img>`, the HTML element still owns its accessible name: use meaningful
`alt` for labelled or consumer-labelled art and `alt=""` for decorative art.
Internal SVG accessibility is not advertised as a replacement for HTML `alt`.

## Consequences

Schema 2 stays readable and closed while representing the common icon model.
The normalized model grows discriminated typed variants, but lifecycle code
does not become a collection of unchecked schema unions. Unsupported CSS,
clipping, masks, filters, symbols, and external references remain visible
profile boundaries.

## Rollback

Do not reinterpret schema 2 as schema 1. Before publication, schema-2 work can
be removed while schema-1 behavior remains intact. After publication, any
incompatible language change requires schema 3 and a deliberate migration.
