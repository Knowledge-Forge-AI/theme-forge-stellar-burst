# TFSB22 deterministic bundle export and manifest round-trip implementation

## Implemented surface

TFSB22 implements deterministic bundle export (`tfsb bundle`), manifest-assisted import (`tfsb import --manifest`), the closed `tfsb-bundle-manifest` schema-1 codec, and manifest identity preservation across reconciliation.

Key implemented elements:
1. **Manifest Codec & Validation (`src/manifest.ts`)**: Strict parser and serializer for closed `tfsb-bundle-manifest` schema version 1. Enforces deterministic key ordering (`kind`, `schemaVersion`, `generator`, `projectName`, `files`), 2-space indentation, final LF, `compareUtf8` sorted `files` array, NFC normalization, portable case-folded collision prevention, lowercase 64-hex SHA-256 digests, and strict schema validation.
2. **Deterministic Bundle Generation (`src/bundle.ts`)**: Generates store-only (compression level 0), DOS timestamp normalized (1980-01-01 00:00:00 UTC), Unix mode `0100644` with DOS archive bit `0x20`, extra-field-free, comment-free ZIP archives. Default bundle enumerates all canonical assets and companions from `LoadedProject.companions` (including companions with zero install destinations). Explicit `--asset` and `--companion` selectors export bounded subsets without inventing or omitting files.
3. **Guarded Output Transaction (`src/bundle.ts`)**: Atomic, link-based exclusive stage file publication for absent targets; `--force` backup-and-replace with automatic rollback restoration on failure; strict project confinement; pre-commit source and target revalidation.
4. **Manifest-Assisted Import (`src/importer.ts`, `src/archive.ts`)**: `readManifestArchive` verifies the presence of root `tfsb-manifest.json`, validates complete archive inventory (no extra, missing, or directory entries), verifies SHA-256 digests of all entries against manifest, and populates canonical project assets preserving explicit manifest `assetId` and filenames. Does not transport install or build policies.
5. **Reconciliation Integration (`src/reconcile.ts`)**: `planReconciliation` tracks candidate assets by archive entry name matching existing provenance records, preserving manifest `assetId` (even when differing from filename stem) and ensuring identical bundle reconciliation yields `UNCHANGED`.
6. **Resource Limits**: Strict bounded ceilings enforced: max 1,024 total ZIP entries, max 128 SVG assets, max 8 MiB per entry, max 32 MiB aggregate content, max 128 MiB archive ceiling.

## Verification

All 22 test suites (270 unit, transaction, determinism, cross-timezone, CLI, and Terminal Nova qualification tests) pass cleanly:
- `test/manifest.test.ts`: Strict schema-1 validation, serialization ordering, and exhaustive failure matrix.
- `test/bundle.test.ts`: Store-only ZIP header inspection, determinism across multiple runs, cross-timezone child process invariance (`TZ=UTC` vs `TZ=America/New_York` vs `TZ=Asia/Tokyo`), subset and default selection.
- `test/bundle-transaction.test.ts`: Sibling stage file creation, concurrency hooks, `--force` replacement and rollback restoration on failure, confinement.
- `test/manifest-import.test.ts`: Manifest-assisted import, inventory verification, tampered digest rejection, provenance alignment.
- `test/reconcile-manifest.test.ts`: Preserving manifest asset ID vs filename stem across reconciliation, tombstone restoration, new entry handling.
- `test/round-trip.test.ts`: All 12 Terminal Nova round-trip qualification scenarios.
