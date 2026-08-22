# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
