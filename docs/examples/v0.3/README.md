# TFSB schema-2 design examples

These files document implemented but unreleased v0.3 syntax, canonical SVG
output, analyzer results, migration, normalization, and provenance schema 2.
They do not change package version `0.2.0` or claim a published v0.3 release.

- `simple-icon-title-only.*`, `lucide-consumer-labelled.*`, and
  `tabler-decorative.*` are synthetic. They demonstrate source-class shapes
  without copying an external project asset.
- `migrated-terminal-nova.*` is derived from the repository-owned Terminal
  Nova production fixture. Its SVG is byte-for-byte equal to the fresh canonical
  schema-1 serialization of `test/fixtures/tftn-production-v1/favicon-on-dark.svg`.
- `unsupported-clipping.svg` is synthetic rejection input. It has no TOML
  counterpart because unsupported source must not become canonical state;
  `unsupported-clipping.analyze.json` shows the valid `drift`/2 two-profile
  envelope and bounded representative diagnostics;
  `unsupported-clipping.analyze.ndjson` shows the corresponding two-profile
  detail stream and records digest.
- `schema-1-ordering-source.svg` and `schema-1-ordering-golden.svg` are
  synthetic frozen-writer evidence. They cover non-ID definition array order,
  shared group presentation/transform, and full schema-1 `<use>` order. They do
  not imply a schema-2 writer exists.

Schema 2 uses closed paint values, typed geometry, and typed transform records.
It has no raw attribute table, CSS string, XML fragment, or generic element
escape hatch.
