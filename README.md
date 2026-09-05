# Theme Forge Stellar Burst

Theme Forge Stellar Burst (TFSB) is a deterministic declarative SVG compiler, transactional installer, and lifecycle drift checker. It turns a bounded, safe subset of SVG into human-editable TOML, compiles canonical standards-compliant SVGs, distributes assets to configured project destinations, and manages upstream asset updates safely without silently overwriting human changes.

```text
SVG bundle
   ↓ import
.tfsb TOML + companions
   ↓ build / install / check
reconcile / diff / fmt / bundle / preview
```

## Why TFSB

Raw SVG is XML: verbose, error-prone to edit by hand, noisy in pull request diffs, and vulnerable to accidental corruption or drift across different application directories.

TFSB brings software-engineering discipline to vector asset pipelines:

- **Human-editable TOML:** Vector graphics are structured in clean, readable TOML rather than unwieldy XML markup.
- **Single source of truth:** `.tfsb` is canonical project state. Change a color, gradient, or dimension once in TOML, then rebuild and reinstall across your entire repository.
- **Interoperable output:** Generated output remains standard, standards-compliant SVG with deterministic attribute ordering, clean formatting, and no proprietary runtime dependencies.
- **Companion integrity:** Opaque brand and legal companion documents (`README.md`, `LICENSE`, `NOTICE`) travel byte-for-byte alongside vector assets without being mutated or executed.
- **Safe reconciliation:** Upstream revisions reconcile against paired-checkpoint provenance so manual edits are never silently clobbered.

## Install

Install globally via npm:

```sh
npm install --global @knowledge-forge-ai/theme-forge-stellar-burst@0.4.0
```

Or add as a project development dependency:

```sh
npm install --save-dev @knowledge-forge-ai/theme-forge-stellar-burst@0.4.0
```

Node.js `22.0.0` or later is required.

## Coordinated v0.4 release

Theme Forge Stellar Burst `0.4.0` is paired with the independently versioned
Theme Forge Nebular Fusion `0.1.0`. Stellar Burst is distributed from the
public `Knowledge-Forge-AI/theme-forge-stellar-burst` history as the npm
package `@knowledge-forge-ai/theme-forge-stellar-burst@0.4.0`. Nebular Fusion
is distributed from `Knowledge-Forge-AI/theme-forge-nebular-fusion` as a
macOS-arm64 application with its own tag, artifacts, notices, and rollback
record. The products share a release family, not a package or publication
transaction.

The release notes and artifact identity record are kept in
[`docs/releases/v0.4.0.md`](docs/releases/v0.4.0.md). The public release URL is
<https://github.com/Knowledge-Forge-AI/theme-forge-stellar-burst/releases/tag/v0.4.0>.
That URL and the paired Nebular release URL become usable only after the
corresponding public release operations complete.

### Optional raster companion

The core npm package does not install the optional PNG renderer. Nebular uses
the private, pinned companion
`@knowledge-forge-ai/tfsb-raster-resvg@0.0.0-tfsb47f` together with
`@resvg/resvg-wasm@2.6.2` from an authenticated release input. It is not a
separately published npm dependency and must not be installed from a registry
reference that is unavailable to consumers.

The retained qualified companion archive is:

```text
knowledge-forge-ai-tfsb-raster-resvg-0.0.0-tfsb47f.tgz
```

Verify the archive digest against Nebular's
`authenticated-inputs/stellar-binding.json` and the published checksum file;
any mismatch blocks distribution. The archive is accompanied by its locked
`package-lock.json` and the AGPL, commercial-license, MPL-2.0, notice, and
third-party-notice files.

## New-project quick start

1. **Import** an archive of vector assets into your project:

   ```sh
   tfsb import brand-assets.zip --root . --companion README.md --record-provenance
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

6. **Inspect** all managed assets, companion documents, and configured destinations:

   ```sh
   tfsb list
   ```

7. **Preview** your asset collection in a static offline visual gallery:

   ```sh
   tfsb preview
   ```

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
  "docs/src/assets/brand/favicon.svg",
]
```

> **Build directory vs. install destinations:**
> - The **build directory** (`brand/dist`) is a TFSB-owned directory that may be wholesale generated and replaced. Protected source trees (`src`, `docs`, `test`) are intentionally forbidden as `build.directory` to prevent accidental deletion of source code.
> - An **install destination** is an individual configured file copy inside the project. Install destinations may live inside source/application trees (such as `docs/src/assets/brand/` or `public/`), provided they do not overlap `.tfsb` or the build directory.

### Optional bundle companion documents

When an archive carries legal, licensing, or brand guidance documents, pass `--companion <path>` during import:

```sh
tfsb import brand-assets.zip --root . --companion README.md --record-provenance
```

Then configure the companion installation in `.tfsb/project.toml`:

```toml
[[companion]]
file = "README.md"
destinations = [
  "README-BRAND.md",
]
```

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

## Updating an existing project

When upstream designers supply a revised ZIP archive, reconcile incoming updates against canonical state and paired provenance checkpoints:

```sh
# 1. Inspect planned changes safely (read-only by default)
tfsb reconcile revised-brand-assets.zip

# 2. Apply planned changes transactionally
tfsb reconcile revised-brand-assets.zip --apply
```

- **Read-only by default:** `tfsb reconcile` analyzes differences without writing to disk.
- **Human canonical edits are never overwritten silently:** Canonical modifications made since the last import/reconcile are detected and preserved.
- **Omissions never delete:** If an asset in your project is omitted from the new archive, it is preserved as an accepted absence (tombstone) rather than silently deleted.
- **Conflicts need exact per-record authority:** When upstream changes conflict with local canonical edits, exact flags (`--resolve <id>=archive|canonical`, `--rename <from>=<to>`, `--remove <id>`) are required to authorize the change.
- **Renames/removals are explicit:** All renames and removals require operator confirmation.

### Released v0.3 migration and normalization surface

Version 0.3.0 includes explicit schema-1 to schema-2 migration and
normalization for supported common SVG sources.

```sh
# Read-only: exit 2 when a complete valid migration is available
tfsb migrate --check
tfsb migrate --check --json

# Transactionally replace one homogeneous schema-1 tree with schema 2
tfsb migrate
tfsb migrate --json
```

Migration reparses the complete proposed tree and requires every schema-1 and
schema-2 canonical SVG output to be byte-identical. Companions and an existing
build receipt are left untouched; the receipt naturally reports source drift
until the next explicit build.

Noncanonical common-v0.3 sources require explicit normalization authority:

```sh
tfsb import source.zip --root . \
  --normalize exact-common \
  --normalization-map normalization-map.toml \
  --record-provenance

tfsb reconcile revised.zip --dry-run \
  --normalize exact-common \
  --normalization-map normalization-map.toml
```

Canonical direct schema-2 input remains direct and needs no normalization
flag. The map is required only where source accessibility intent cannot be
derived safely. Reconciliation of changed normalized source accepts only the
stored policy identity or a formatting-equivalent map with the same canonical
digest; unavailable or semantically changed authority blocks the operation.

## Portable bundles

Export your canonical project into a portable, reproducible ZIP bundle:

```sh
# Export complete canonical assets and companions
tfsb bundle --output release/brand-assets.zip

# Import into a clean project preserving declared asset IDs and names
tfsb import release/brand-assets.zip --manifest --root ../fresh-copy
```

- **Deterministic store-only ZIPs:** Bundle archives use level 0 compression, fixed timestamps, and canonical header sorting for byte-stable hashes across environments.
- **Exact manifest verification:** The bundle includes `tfsb-manifest.json` containing cryptographic SHA-256 digests and asset identifiers.
- **Identity preservation:** Importing with `--manifest` restores declared asset IDs and file names instead of guessing from basenames.
- **No policy transport:** Bundles transport only canonical artwork and companion documents; installation destinations and provenance history remain private to each repository.

## Inspection and automation

TFSB provides rich inspection, formatting, and diffing tools for CI/CD and developer workflows:

```sh
# Compare canonical state against paired provenance checkpoint
tfsb diff

# Compare canonical state against an external archive
tfsb diff --archive revised.zip

# Compare canonical state against build outputs (requires v3 receipt)
tfsb diff --build

# Compare canonical state against installed destinations
tfsb diff --install

# Check canonical TOML formatting without writing
tfsb fmt --check

# Format canonical TOML files deterministically
tfsb fmt

# Render an offline HTML preview gallery
tfsb preview

# Emit machine-readable output for automation
tfsb check --json
```

### Automation & machine results

Commands supporting `--json` (`check`, `list`, `migrate`, `reconcile`, `diff`, `bundle`, `fmt`, `preview`) emit a single envelope matching JSON schema version 1 with deterministic key sorting:

- **Exit code `0`:** Clean / success.
- **Exit code `1`:** Invalid / failed operation.
- **Exit code `2`:** Valid drift / conflict state.

## Upgrading a v0.1 project

Upgrading an existing v0.1 project to v0.2 is straightforward:

- **Bootstrap provenance:** A matching archive can bootstrap provenance with `reconcile ... --apply` to generate `.tfsb/provenance.json`.
- **Mismatching archive:** A mismatching archive requires explicit decisions (`--resolve`, `--rename`, `--remove`).
- **Build receipts:** Valid v2 build receipts remain accepted as build ownership evidence for `check`, `build`, and `install`.
- **Upgrade to v3 receipt:** Run `tfsb build` once to emit v3 policy evidence before using `diff --build`.
- **Preview directory:** `.tfsb-preview` is generated state and should be added to `.gitignore`.

## Safety and limits

TFSB is built with a defense-in-depth safety architecture:

- **Local ZIPs only:** Processes only local archives provided by the operator; no arbitrary network access.
- **Fail-closed SVG subset:** Supports a safe declarative subset (paths, groups, linear gradients, use references, accessibility tags). Scripts, CSS `<style>` blocks, external resources, foreign objects, and unparsed XML fail closed.
- **No scripts/external resources:** Scripts (`.js`, `.ts`, `.py`, `.sh`) and executable companion files are rejected immediately.
- **Explicit normalization only:** `exact-common` performs a closed set of typed operations. It never repairs arbitrary IDs, CSS, external references, or unsafe/unsupported content.
- **Path/symlink confinement:** Absolute paths, `..` traversal, and symlink traversals fail closed across all read, write, build, and install operations.
- **Exact companion allowlist:** Only text documentation (`*.md`, `*.markdown`, `*.txt`) and well-known legal documents (`LICENSE`, `NOTICE`, `COPYING`, `COPYRIGHT`) are permitted as companions.
- **Limits:** Maximum 1,024 archive entries, maximum 128 selected/mutating SVG assets, 8 MiB per selected entry, 32 MiB selected aggregate, and 128 MiB raw archive size.
- **Full external icon warehouses are not a v0.2 lifecycle target:** TFSB is designed for bounded, curated brand and application icon sets.

## Development

Run unit and integration tests:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Run browser visual-equivalence qualification:

```sh
npx playwright install chromium firefox webkit
npm run test:visual
```

For format examples, see the [v0.1 assets](docs/examples/v0.1/README.md)
and [v0.2 lifecycle examples](docs/examples/v0.2/README.md).

## License

This project is licensed under the **GNU Affero General Public License v3.0 or later** ([AGPL-3.0-or-later](LICENSE)). See [NOTICE](NOTICE) for copyright and attribution details.

Commercial licenses are available for proprietary integration, closed-source distribution, OEM bundling, or organizations requiring custom licensing terms. Commercial licensing does not restrict permitted AGPL use. Inquiries: `lair001@gmail.com`. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
