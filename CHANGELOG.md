# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-08-24

Major feature release advancing Theme Forge Stellar Burst with productized archive pre-import analysis (`tfsb analyze`), Schema 2 vector models and typed geometric primitives, granular accessibility modes (`labelled`, `decorative`, `consumer_labelled`), direct canonical Schema 2 import, explicit exact-common normalization with normalization map schema 1 and `tfsb-normalization-policy-v1`, provenance schema 2, deterministic Schema 1 to Schema 2 migration (`tfsb migrate`), schema-2 reconciliation, raw versus normalized archive diffing, deterministic bundle and manifest compatibility, scriptless offline preview galleries, and frozen Schema 1 backward compatibility.

### Added

- **Productized Pre-Import Analysis (`tfsb analyze`):**
  - Upstream archive and directory tree scanning classifying assets into `directly_importable`, `importable_with_normalization`, `unsupported`, or `unsafe`.
  - Machine-readable `--json` single-envelope output and formatted human summaries.
- **Schema 2 Vector Model & Typed Primitives:**
  - `schema_version = 2` for project and asset TOML.
  - Typed geometric primitives: `circle`, `ellipse`, `rect`, `line`, `polyline`, `polygon`.
  - Root and element presentation attributes and `currentColor` token support.
  - Typed `translate`, `scale`, and `rotate` transforms.
  - Mixed and nested groups up to depth 8.
  - Typed local `<defs>` and `<use>` references.
- **Granular Accessibility Modes:**
  - Modeled `labelled`, `decorative` (`aria-hidden="true"`), and `consumer_labelled` modes.
- **Direct Schema-2 Import & Exact-Common Normalization:**
  - Direct import for canonical Schema 2 SVGs.
  - Deterministic exact-common normalization (`--normalize exact-common`) backed by `normalization-map.toml` schema 1 and cryptographic `tfsb-normalization-policy-v1` policy digests.
- **Provenance Schema 2 & Migration (`tfsb migrate`):**
  - Schema 2 paired-checkpoint provenance tracking.
  - Safe, whole-project deterministic migration from Schema 1 to Schema 2 with non-destructive `--check` planning and verified byte-level equivalence.
- **Schema-2 Reconciliation & Archive Diffing:**
  - Multi-baseline archive diffing against raw sources and normalized canonical models.
  - Safe reconciliation against Schema 2 assets with explicit authority enforcement.

## [0.2.0] - 2026-08-22

Major feature release expanding Theme Forge Stellar Burst from an initial compiler into a complete lifecycle management system for vector assets, introducing safe archive reconciliation, paired-checkpoint provenance, deterministic bundle export/import, semantic diffing, canonical formatting, static offline visual previews, and versioned JSON machine automation.

### Added

- **Safe Incremental Reconciliation (`tfsb reconcile`):**
  - Paired-checkpoint provenance tracking (`.tfsb/provenance.json`) recording both archive-entry digests and canonical-output digests.
  - Read-only classification by default (`--dry-run` alias) returning exit `2` for valid pending, omitted, untracked, or conflicting changes.
  - Explicit per-record authority flags: `--resolve <id>=archive|canonical` for merge conflicts, `--rename <from>=<to>` and `--rename-companion <from>=<to>` for file renames, and `--remove <id>` and `--remove-companion <file>` for deletions.
  - Omission never deletes: assets omitted from upstream archives become accepted absences (tombstones) and are preserved until explicitly removed.
  - Atomic transactional commit (`--apply`) with rollback protection, pre-lock planning, and lock-held validation.

- **Deterministic Bundle Export & Manifest-Assisted Import (`tfsb bundle`, `tfsb import --manifest`):**
  - Store-only (level 0) deterministic ZIP generation with fixed MS-DOS timestamps and sorted central directory headers for byte-identical reproducibility across platforms and timezones.
  - Cryptographic `tfsb-manifest.json` tracking canonical asset IDs, file names, and SHA-256 digests.
  - Selective bundle export using repeated `--asset <id>` and `--companion <file>` filters.
  - Manifest-assisted import (`--manifest`) preserving declared asset identifiers and names without guessing from basenames.
  - Provenance initialization during import via `--record-provenance`.

- **Semantic Multi-Baseline Diffing (`tfsb diff`):**
  - Compares canonical `.tfsb` source semantics against four independent operational baselines: `--provenance` (default), `--archive <file.zip>`, `--build`, and `--install`.
  - Typed semantic difference reporting (canvas, accessibility, definitions, element tree, path text) using the frozen `tfsb-path-text-v1` digest.
  - Exit code parity: exit `0` for identical state, `2` for valid semantic differences, `1` for invalid or unavailable baselines.

- **Canonical TOML Formatter (`tfsb fmt`):**
  - Deterministic whitespace, key order, and layout formatting for `.tfsb/project.toml` and `.tfsb/assets/*.toml`.
  - Non-destructive `--check` mode exiting `2` when formatting differences are present.
  - Semantic-preserving and provenance-preserving whole-tree transactional application.

- **Offline Static Preview Gallery (`tfsb preview`):**
  - Generates an offline, scriptless, fully escaped HTML/CSS asset gallery in `.tfsb-preview`.
  - Renders directly from freshly parsed canonical TOML models, guaranteeing artwork fidelity independent of build state.
  - Displays multi-size responsive grids (16px to 256px), aspect ratio profiles, and build/install drift badges.
  - Marker-owned directory safety preventing accidental clobbering of unowned directories.
  - Best-effort browser launcher (`--open`).

- **Versioned JSON Machine Results (`--json`):**
  - Structured schema-version-1 JSON envelopes for automation across `check`, `list`, `reconcile`, `diff`, `bundle`, `fmt`, and `preview`.
  - Deterministic key ordering, structured diagnostic locations, and complete unfiltered result collections.

- **Relocatable v3 Build Receipts & Receipt Upgrades:**
  - `tfsb-build-v3` receipts storing normalized project install policy digests alongside build outputs.
  - Transparent backward compatibility: valid `tfsb-build-v2` receipts continue to serve as build ownership evidence for `check`, `build`, and `install`, upgrading to `v3` on the next build.

- **Hardened Security & Concurrency:**
  - Symlink no-follow protections: build receipts, generated outputs, and install destinations must be regular files.
  - Aggregate limit enforcement: maximum 1,024 archive entries, 128 mutating SVG assets, 8 MiB per entry, 32 MiB aggregate selected bytes, and 128 MiB raw archive size.
  - Concurrency lock protection (`.tfsb.lock`) with active plan staleness detection.

- **Flagship Terminal Nova Qualification:**
  - End-to-end qualification across the complete production vector brand asset corpus of Theme Forge Terminal Nova.

### Limitations

- **Bounded Schema-1 SVG Profile:** Supports a safe declarative subset (paths, groups, linear gradients, use references, accessibility tags). Scripts, `<style>` sheets, animations, filters, and foreign XML elements fail closed.
- **Local Archives Only:** All import, reconcile, diff, and bundle operations require local filesystem ZIP archives; remote network URLs are not supported.
- **Project Boundary & Curated Scope:** Designed for curated application/brand icon systems (up to 128 mutating assets); full external icon warehouses are not a v0.2 lifecycle target.
- **No Raw XML Escape Hatch:** All vector assets must conform strictly to typed TOML schemas.
- **Mutation Commands Exclude JSON:** `import`, `build`, and `install` intentionally reject `--json`.
- **Preview is Scriptless:** Preview galleries contain zero JavaScript and require no local HTTP server.

## [0.1.0] - 2026-08-22

Initial release of Theme Forge Stellar Burst (TFSB), a deterministic declarative SVG compiler, transactional installer, and drift checker.

### Added

- **Declarative SVG TOML Schema (schema_version = 1):**
  - Canonical TOML representation for vector assets (`.tfsb/project.toml` and `.tfsb/assets/*.toml`).
  - Typed definitions for canvases (with optional `width` and `height`, and `view_box`), accessibility (`<title>`, `<desc>`, `focusable`), linear gradients, grouped elements, stroked/filled paths, presentation attributes (`opacity`, `aria_hidden`), and transformed `<use>` instances.
  - Multi-line path data formatting and deterministic serialization.

- **Safe In-Memory Archive Import (`tfsb import`):**
  - Robust import of local SVG ZIP archives into declarative TOML project structures.
  - Fail-closed archive parser rejecting path traversal (`..`), absolute paths, zip slips, and symlinks.
  - Ignores ordinary safe non-SVG archive members by default; supports explicit `--companion <entry>` selection for opaque text companion documents.
  - Selective SVG import via repeated `--select <path>` arguments and previewing via `--dry-run`.

- **Deterministic SVG Compiler (`tfsb build`):**
  - Compiles `.tfsb` TOML configurations into byte-for-byte deterministic, standards-compliant SVG files.
  - Generates cryptographic build receipts (`.tfsb-build.json`) in the build directory tracking canonical SHA-256 digests.
  - Consistent XML formatting, stable attribute ordering, and fallback fills for modern gradient syntax.
  - Non-destructive execution and `--dry-run` inspection mode.

- **Transactional Installer (`tfsb install`):**
  - Atomically writes compiled SVGs and companion documents to configured project destinations across the repository.
  - Strict project-root confinement preventing writes outside the repository boundary.

- **Cryptographic Drift Detection (`tfsb check`):**
  - Validates project integrity across source TOML, build artifacts, and installed destinations (including companion files).
  - Standardized exit codes: `0` (clean/valid), `1` (invalid schema or configuration error), `2` (drift detected in source, build, or installed files).

- **Project Inspection & CLI Ergonomics:**
  - `tfsb list` command for displaying configured assets, companion documents, and target destinations.
  - Full CLI help (`--help`, `-h`) and version reporting (`--version`, `-v`).
  - Automatic ancestor project-root discovery.

- **Browser Visual-Equivalence Qualification:**
  - Multi-browser visual regression testing suite with Playwright (Chromium, Firefox, WebKit).
  - Deterministic same-run pixel comparison verifying visual parity between original imported SVGs and rebuilt/installed outputs across flagship Terminal Nova assets.

### Limitations

- **Bounded Declarative Language:** TFSB compiles a bounded SVG declarative language and can carry explicitly selected opaque text companion documents. Companion documents are copied byte-for-byte; they are never parsed as SVG, transformed, executed, or generalized into arbitrary package installation.
- **SVG-Only:** TFSB manages SVG vector assets only; raster images, icon fonts, and arbitrary binary packages are not supported.
- **Bounded SVG Subset:** Only supported declarative elements (paths, groups, linear gradients, use tags) are admitted; scripts, foreign objects, embedded styles, animations, and non-linear gradients fail closed.
- **Local Archives Only:** Import operates strictly on local file paths; remote URL downloading is intentionally excluded.
- **No Raw XML Escape Hatch:** All managed assets must conform to the typed schema; unparsed raw XML blocks cannot be bypassed.
- **Node Requirement:** Requires Node.js 22.0.0 or higher.
