# TFSB33 implementation: migration, normalization, and provenance schema 2

## Status and scope

TFSB33 implements the unreleased schema-1 to schema-2 migration and explicit
`exact-common` normalization authority. The package remains `0.2.0`; this work
does not publish or alter public v0.2.0, raise limits, add dependencies, add a
directory workflow, or begin collection/workspace/source-map work.

## Frozen digests and provenance

`tfsb-svg-output-v1` is SHA-256 over the exact canonical SVG UTF-8 bytes from
the active frozen writer. Migration serializes both schemas independently and
requires exact byte equality before any stage can be promoted.

Provenance schema 2 separates `archive`, `migration`, and
`normalizationPolicy`. Every digest carries its basis. `archive: null` remains
an explicit absence of archive observation; migration never invents one.
Existing partial and complete schema-1 checkpoints retain their exact archive
relations, while every migrated canonical asset receives independent schema
and SVG transition evidence.

The frozen no-map policy vector is:

```text
tfsb-normalization-policy-v1 =
sha256:055f6e969fad72e651ce1ad9ae5cac008e3b2d31748cd68ffa589c0e5052c68f
```

The checked formatting-equivalent map test freezes:

```text
normalization-map schema 1 =
sha256:881096ee08db4fa5c6194ee5e24e29c575df6d4a2cd1600306802be713f2b5c2

tfsb-normalization-policy-v1 =
sha256:38c6bce5b6a8c7e71a3a19ffbf32da1d653dfe80053519efb56ee8d173eb9649
```

The policy digest uses the architecture-frozen ASCII prefix, compact JSON
identity, and final LF. It excludes map path, root, archive path, user, host,
working directory, and environment. Formatting-equivalent maps reproduce the
same canonical bytes; semantic authority changes do not.

## Migration and normalization surfaces

The CLI additions are `tfsb migrate --check [--json]` and
`tfsb migrate [--json]`. Check mode is read-only, does not acquire the mutation
lock, returns drift/2 when a valid migration is needed, ok/0 for schema 2, and
error/1 for an invalid or unrepresentable migration. Apply consumes only its
private authentic plan and uses the existing complete-tree lock, stage,
reparse, backup, promotion, rollback, and recovery-residue protocol.

Import and reconcile accept `--normalize exact-common`,
`--normalization-map <file>`, and their existing read-only/apply controls.
Direct canonical schema-2 import remains parser-and-byte based and requires no
policy. Manifest inventory, declared hashes, filenames, and asset IDs are
verified before normalization. The per-source ledger binds source snapshot,
both analyzer classifications, explicit accessibility authority, ordered
closed operations, before/after digests, policy digest, and disposition without
raw XML, path data, companion bytes, or environment data.

Schema-2 reconcile retains paired human-canonical ownership. Unchanged raw
checkpoints remain historical observations, migrated schema-1 source is an
explicit SVG-equivalent divergence, changed normalized source requires the
exact stored or formatting-equivalent re-supplied policy/map, and simultaneous
canonical/source change remains a conflict. Archive diff reports raw-source
relation and normalized semantic comparison separately, including an explicit
`authority_required` / `unavailable` state.

## Analyzer parity and dogfood

Element IDs, local `href`, paint references, and both real parsers now share
the closed local-ID grammar; colons are not repaired or accepted. The analyzer
recognizes parser-accepted ASCII whitespace in gradient fallback and marks
noncanonical path, transform, viewBox, and gradient whitespace as requiring
normalization. The public analyzer details schema retains its frozen operation
registry; the dry-run ledger records parser whitespace canonicalization in its
own closed schema.

Two fresh runs over Git-archive-derived regular SVGs from all four exact pinned
revisions were byte-identical to each other and to the TFSB32R1 aggregate and
detail digests. Common-v0.3 counts remain:

| Corpus | Direct | Normalize | Unsupported | Unsafe |
| --- | ---: | ---: | ---: | ---: |
| Lucide | 0 | 2,147 | 89 | 20 |
| Simple Icons | 0 | 3,453 | 0 | 0 |
| Tabler Icons | 0 | 6,184 | 1 | 225 |
| theSVG | 2 | 8,022 | 3,644 | 789 |

No dogfood checkout was mutated and no dogfood source was copied into the
repository.

## Acceptance and failure evidence

Terminal Nova migrates independently from absent, partial, and complete
provenance. Every run proves ten exact SVG byte/digest equalities, exact legal
companion bytes, a byte-untouched stale build receipt, homogeneous schema 2,
and continued format, build, install, check, list, provenance/archive diff,
reconcile, bundle, and preview behavior. A changed Terminal Nova archive is
fresh schema-1 source and produces an archive-change decision rather than a
false convergence.

Failure injection covers stale/forged plans, canonical and archive changes,
normalization-map changes, lock contention, stage creation/write/validation,
promotion, successful rollback, failed rollback residue, active-new backup
cleanup failure, and concurrent initial-root creation. Shared guards prove the
exact 128-asset and 32 MiB boundaries accept equality and reject one over.
Transaction lock cleanup now verifies the created lock identity before removal.

## Verification result

- TypeScript checks passed for product, visual, and tools configurations.
- Vitest passed 36 files / 506 tests.
- Playwright passed 114 Chromium, Firefox, and WebKit tests.
- `npm audit --omit=dev` reported zero vulnerabilities.
- `npm pack --dry-run --json` reported package version `0.2.0` and 103
  intentional payload entries.
- `git diff --check` passed.
- Package metadata, dependency manifests, lockfile, schema-1 frozen fixtures,
  schema-2 core vectors, and dogfood source checkouts are unchanged.

## Deferrals

Directory import/reconcile, collection identity, prefixes, workspaces, shards,
source maps, higher limits, unsafe-content normalization, arbitrary CSS/XML,
new SVG constructs, a generic repair command, package-version changes, release
publication, and all v0.4/Studio work remain deferred.
