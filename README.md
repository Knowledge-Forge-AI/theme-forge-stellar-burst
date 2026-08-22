# Theme Forge Stellar Burst

Theme Forge Stellar Burst (TFSB) is a deterministic declarative SVG compiler, transactional installer, and drift checker. It imports supported SVG assets into human-editable TOML configuration, compiles canonical standards-compliant SVG, distributes assets to configured project destinations, and verifies that source, build artifacts, and installed files never drift out of sync.

```text
SVG archive ──► .tfsb TOML ──► build ──► install ──► check
```

## Why TFSB

Raw SVG is XML: verbose, error-prone to edit by hand, noisy in pull request diffs, and vulnerable to accidental corruption or drift across different application directories.

TFSB establishes `.tfsb` TOML files as the single canonical source of truth for your vector assets:

- **Human-editable:** Assets are structured in clean, readable TOML rather than unwieldy XML markup.
- **Single source of truth:** Change a color, gradient, or dimension once in TOML, then rebuild and reinstall across your entire repository.
- **Interoperable output:** Generated output is standard, standards-compliant SVG with deterministic attribute ordering, clean formatting, and no proprietary runtime dependencies.
- **Integrity verification:** Built-in cryptographic drift checks ensure installed SVGs match the canonical source and haven't been modified out-of-band.

## Install

Install globally via npm:

```sh
npm install --global @knowledge-forge-ai/theme-forge-stellar-burst
```

Or add as a project development dependency:

```sh
npm install --save-dev @knowledge-forge-ai/theme-forge-stellar-burst
```

Node.js `22.0.0` or later is required.

## Quick start

1. **Import** an archive of vector assets into your project:

   ```sh
   tfsb import ~/Downloads/brand-assets.zip --root .
   ```

2. **Configure** target destinations in `.tfsb/project.toml`.

3. **Build** canonical SVGs into the build directory:

   ```sh
   tfsb build
   ```

4. **Install** compiled SVGs to configured project locations:

   ```sh
   tfsb install
   ```

5. **Verify** that sources, builds, and installed files are synchronized:

   ```sh
   tfsb check
   ```

6. **Inspect** all managed assets and destination paths:

   ```sh
   tfsb list
   ```

## What the configuration looks like

### Project configuration (`.tfsb/project.toml`)

```toml
schema_version = 1
name = "My Application Brand"

[build]
directory = "brand/dist"

[[install]]
asset = "favicon"
destinations = [
  "public/favicon.svg",
  "docs/public/favicon.svg",
]
```

> **Build directory vs. install destinations:**
> - The **build directory** (`brand/dist`) is a TFSB-owned directory that may be wholesale generated and replaced. Protected source trees (`src`, `docs`, `test`) are intentionally forbidden as `build.directory` to prevent accidental deletion of source code.
> - An **install destination** is an individual configured file copy inside the project. Install destinations may live inside source/application trees (such as `docs/src/assets/brand/` or `docs/public/`), provided they do not overlap `.tfsb` or the build directory.

### Optional bundle companion documents

When an archive carries legal, licensing, or brand guidance documents (such as `README.md`, `LICENSE`, `NOTICE`, `COPYING`, or `COPYRIGHT`), pass `--companion <path>` during import:

```sh
tfsb import ~/Downloads/brand-assets.zip --root . --companion README.md
```

Then configure the companion installation in `.tfsb/project.toml`:

```toml
[[companion]]
file = "README.md"
destinations = [
  "README-BRAND.md",
]
```

Companion documents are explicitly selected during import, preserved into `.tfsb/companions/*`, and installed byte-for-byte across your project.

### Asset configuration (`.tfsb/assets/favicon.toml`)

```toml
schema_version = 1
id = "favicon"
filename = "favicon.svg"

[canvas]
width = 64
height = 64
view_box = "0 0 64 64"
shape_rendering = "geometricPrecision"

[accessibility]
title = "Application Favicon"
title_id = "app-favicon-title"
description = "Application brand favicon."
description_id = "app-favicon-desc"

[[definitions.linear_gradients]]
id = "brand-gradient"
x1 = 22
y1 = 21
x2 = 42
y2 = 43
units = "userSpaceOnUse"
stops = [
  { offset = 0, color = "#FF8A3D" },
  { offset = 1, color = "#8B5CF6" },
]

[[elements]]
type = "path"
id = "center-mark"
fill = "url(#brand-gradient)"
fill_fallback = "#FF8A3D"
d = "M32 20 C33 26.5 36 29.5 44 32 C36 34.5 33 37.5 32 44 C31 37.5 28 34.5 20 32 C28 29.5 31 26.5 32 20Z"
```

## Commands

- **`tfsb import <archive.zip>`**: Safely parses a local ZIP archive, validates every SVG against the supported schema, and writes `.tfsb/project.toml` and `.tfsb/assets/*.toml`. Supports `--select <path>` to selectively import specific SVGs, `--companion <path>` to carry opaque companion documents, and `--dry-run` to preview changes.
- **`tfsb build`**: Compiles all `.tfsb/assets/*.toml` files into deterministic SVG output files in the configured build directory and writes `.tfsb-build.json`.
- **`tfsb install`**: Copies built SVGs and companion documents transactionally to their configured destinations across the repository.
- **`tfsb check`**: Validates project structure and detects drift. Returns exit code `0` when clean, `1` on invalid schema/configuration, or `2` when source, build, or installed files have drifted.
- **`tfsb list`**: Displays a formatted manifest of all managed assets, companion documents, and configured installation destinations.
- **`tfsb --help` / `tfsb --version`**: Shows command help or the installed package version (`0.1.0`).

## Safety and scope

- **Bounded Declarative Language & Companion Documents:** TFSB compiles a bounded SVG declarative language and can carry explicitly selected opaque text companion documents (`*.md`, `*.markdown`, `*.txt`, or well-known legal documents `LICENSE`, `NOTICE`, `COPYING`, `COPYRIGHT`) with an SVG bundle. Companion documents are copied byte-for-byte; they are never parsed as SVG, transformed, executed, or generalized into arbitrary package installation. Script and code files (`.py`, `.sh`, `.js`, `.ts`) are rejected.
- **Local archives only:** TFSB processes only local ZIP archives provided by the operator; it does not download from arbitrary URLs.
- **Safe archive parsing:** Archives are parsed in memory with strict path canonicalization. Absolute paths, `..` traversal, and symlinks fail closed. Ordinary safe regular non-SVG members in the archive are ignored by default unless explicitly selected with `--companion`, and selecting a non-SVG member with `--select` or selecting an unsupported companion type fails closed.
- **Project-root confinement:** All write operations (build outputs and installed files) are strictly confined to the project directory tree. Path traversal outside the root is blocked.
- **Fail-closed bounded subset:** TFSB supports an intentionally bounded declarative subset of SVG (paths, groups, linear gradients, use references, accessibility tags). Unsupported elements, arbitrary scripts, external CSS, foreign objects, and unparsed XML are rejected rather than guessed or approximated.

## Development

Run unit and integration tests:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Run browser visual-equivalence qualification:

```sh
npx playwright install chromium firefox webkit
npm run test:visual
```

For more architectural background, see:
- [v0.1 Architecture Specification](docs/architecture/v0.1.md)
- [ADR 0001: Declarative SVG Language](docs/decisions/0001-declarative-svg-language.md)
- [Visual Qualification Framework](docs/implementation/tfsb3-visual-testing.md)

## License

This project is licensed under the **GNU Affero General Public License v3.0 or later** ([AGPL-3.0-or-later](LICENSE)). See [NOTICE](NOTICE) for copyright and attribution details.

Commercial licenses are available for proprietary integration, closed-source distribution, OEM bundling, or organizations requiring custom licensing terms. Commercial licensing does not restrict permitted AGPL use. Inquiries: `lair001@gmail.com`. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
