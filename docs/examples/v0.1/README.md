# TFSB schema-1 examples

These files are concrete proposed v0.1 syntax, derived from `test/fixtures/tftn-icon-candidate-v1/`. They are design fixtures, not an active `.tfsb` project and not literal import output. Their concise IDs (`favicon`, `mark`, and `lockup-horizontal`) demonstrate ordinary human edits after deterministic import; import itself derives longer IDs from the archive filename stems and fails on collisions.

```text
project.toml
assets/
  favicon.toml
  mark.toml
  lockup-horizontal.toml
model.ts
```

The three assets deliberately cover the hardest language seams:

- favicon: group-level paint, multiline geometry, text metadata, and gradient fallback;
- mark: per-path IDs/paint and gradient fallback;
- horizontal lockup: reusable definitions, open path glyphs, local uses, transforms, strokes, and per-use color.

The asset files are self-contained artwork. Shared build placement and install destinations live only in `project.toml`. `model.ts` sketches the TOML-facing TypeScript types; decoding still requires runtime validation and normalization.
