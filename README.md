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

Install the current registry release globally via npm. The registry's `latest` tag is the installation
target; `npm view @knowledge-forge-ai/theme-forge-stellar-burst dist-tags.latest` shows which version that is.
This source describes version 0.7.0.

```sh
npm install --global @knowledge-forge-ai/theme-forge-stellar-burst
```

Or add as a project development dependency:

```sh
npm install --save-dev @knowledge-forge-ai/theme-forge-stellar-burst
```

Node.js `22.0.0` or later is required.

Version 0.5.0 adds the closed `./scene/v1` library export and `tfsb scene`
commands for accessible vector scenes, deterministic SVG compilation, layout,
labels and bounded SVG import. See the [Scene contract](protocol/tfsb-scene-v1/README.md)
and [import contract](protocol/tfsb-scene-v1/import-svg.md). Existing 0.4 asset,
installation and drift contracts remain supported.

The registry release distributes SVG assets. Clips, masks, embedded or
external resource ingestion, and distributed PNG output remain outside this
delivery contract. The `nova-social` SVG does not guarantee compatibility
with social-platform image uploaders.

## Release family and history

Version 0.7.0 follows the 0.6.1 maintenance line.
Historical [0.5.0 release](https://github.com/Knowledge-Forge-AI/theme-forge-stellar-burst/releases/tag/v0.5.0)
content remains part of the release history.
Historical [0.4.0 release notes](docs/releases/v0.4.0.md) retain their original scope.
Related products are independently versioned:
[Stellar Loom](https://github.com/Knowledge-Forge-AI/theme-forge-stellar-loom),
[Nebular Fusion](https://github.com/Knowledge-Forge-AI/theme-forge-nebular-fusion), and
[Terminal Nova](https://github.com/Knowledge-Forge-AI/starlight-theme-terminal-nova).
Each has its own artifacts, notices and qualification.

## Illustration authoring from SVG

The published npm 0.7.0 CLI supports scene compilation and SVG import.
The registry release lacks `trace-png`, `trace-webp` and `export-webp`.
Use a qualified engineering build, such as the exact Apple Silicon package
and raster companion from [the PR #35 CI run][illustration-build].
The workflow below uses that build's scene commands and requires the
qualified encoder described below.

[illustration-build]: https://github.com/Knowledge-Forge-AI/theme-forge-stellar-burst/actions/runs/45819597663

Keep the reviewed, full-artboard SVG as the illustration source. An
editable scene JSON file lets you revise paths or append a named group
and compile a new SVG. WebP is the delivery file. A raster reference
can seed the SVG through tracing, which approximates the reference as
editable paths.

Start with a static, metadata-free WebP or a PNG at the intended artboard
size. Use `--native-detail` for fine artwork and add `--preserve-alpha`
for a transparent reference. WebP tracing uses the qualified `magick`
executable. For a PNG reference, use `scene trace-png`.
Add `--fine-alpha` with both `--native-detail` and `--preserve-alpha`
to use finer low-alpha grouping. Source alpha below 8 stays transparent;
alpha from 8 through 119 uses 8-unit band rounding with up to 14 colors
per band. Higher alpha retains 16-unit grouping with up to 32 colors per
partially transparent band and the existing near-opaque threshold of 248.
Occupied bands retain their mean source alpha. Default tracing is unchanged.

The matched cross-character experiment retained the complete 1024 × 1536
canvas, 1,746 detail paths, 64 coarse paints, and 47 fine paints. Native
exported WebP mean alpha error fell by 3.6% for Orihime, 5.9% for Hikari,
8.6% for Shiori, and 5.1% for Rei. These are experiment results; RGB and
responsive-size gains varied. Finer alpha grouping can improve full-size
transparency while changing color allocation and contour complexity.
The native-large profile reserves room for 64 coarse paints, up to 47 fine
paints, and their shared opacity group before assigning near-opaque detail
colors. Limit-driven retries can reduce tracing resolution while retaining
the complete canvas. Eligible paint is retained on each attempt; fine-alpha
can reject a trace where default tracing would return detail-only.
Small artworks and regions without eligible paint can still use detail-only.
Full-size and responsive browser assessment remains parent-owned.

Add `--fit-source-colors` to fit the existing opaque native contours'
fill colors to their source pixels. It requires the directional trace
at the exact source grid and fails if that trace exceeds the existing
limits. Reuse the option when retracing a region with `--exclude-detail`.
The default trace balances detail and size. Use `--illustration-source`
to enforce the 16,000,000-byte cap when compiling. Reviewed SVG import and
WebP export apply the same cap.

```sh
tfsb scene trace-webp reference.webp --native-detail --output artwork.scene.json
tfsb scene trace-png transparent.png --native-detail --preserve-alpha --fine-alpha --output transparent.scene.json
tfsb scene compile artwork.scene.json --illustration-source --output artwork.svg --json > compile.json
```

Review the SVG. Export it with the digest from that compilation:

```sh
svg_digest=$(node -e 'const fs = require("node:fs"); const r = JSON.parse(fs.readFileSync("compile.json", "utf8")); process.stdout.write(r.data.receipt.svgDigest)')
tfsb scene export-webp artwork.svg --expect-svg-digest "$svg_digest" \
  --output artwork.webp --json > export.json
```

The export requires the separately qualified
`@knowledge-forge-ai/tfsb-raster-resvg` companion and a
qualified `magick` executable on the host. The companion binds the
`@resvg/resvg-wasm` renderer in the verified engineering build. The export receipt binds the
source SVG, renderer, PNG, recipe and WebP bytes. Output files must be
new paths. Keep the SVG and export receipt alongside the delivery file.

Use `--output-width 512` with a new output path to export a narrower
WebP. Its height must be a whole number of pixels at the source ratio.
The option retains the same SVG and PNG digests in the export receipt.
The resize filter defaults to Lanczos. With `--output-width`, use
`--resize-filter Catrom` for Catmull–Rom or `--resize-filter Mitchell` for
Mitchell. Use `--resize-filter Box` to opt in to box averaging when downsampling for a
responsive export. Compare the result at its intended display sizes. The
receipt records the chosen filter in the replayable recipe.
Filter selection requires `--output-width`, including with `--viewbox-size`.
A width equal to the artboard width is allowed; filter selection does not
require smaller output dimensions. With `--viewbox-size`, resizing
uses the viewBox raster dimensions, so output wider than that raster is
enlarged even when it fits within the artboard.
Add `--quality 93 --sharp-chroma` to select the Compact Sharp recipe.
Standard export defaults to quality 94 and recipe version 1. Sharp
chroma uses recipe version 2. Retain that recipe with the matching PNG
to replay it with `tfsb illustration export`. Box recipes require a
Stellar Burst version that admits Box; older verifiers reject that filter.

To reopen the reviewed SVG for editing, pass the matching digest to
`scene import-svg`. Compile edits to a new SVG and export against its
new digest. Reviewed import and export recognize spaced and compact
compiler output. Use `--compact-paths` when recompiling to retain compact
path spelling.

```sh
tfsb scene import-svg artwork.svg --svg-source --expect-svg-digest "$svg_digest" \
  --output reopened.scene.json
```

For path edits, supply `edits.json` as an array of objects with an
existing path `id` and its replacement SVG path data `d`.

```sh
tfsb scene revise reopened.scene.json --edits edits.json --output revised.scene.json
tfsb scene compile revised.scene.json --illustration-source --output revised.svg --json > revised-compile.json
```

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

Commercial licenses are available for proprietary integration, closed-source distribution, OEM bundling, or organizations requiring custom licensing terms. Commercial licensing does not restrict permitted AGPL use. Inquiries: `sam.lair@knowledge-forge.ai`. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).


## Multi-platform native build

Since 0.6.0, Burst carries GNU/glibc Linux ARM64 (`linux-arm64-gnu`) alongside
Darwin ARM64, GNU Linux x64 and preserved Darwin x64. npm retains one package
carrying authentic native prebuilds; normal installation selects the local target
without downloading project binaries at first launch. This does not revise the
v0.5.0 platform claims.

Build from public source with Nix using `nix build .#theme-forge-stellar-burst`.
See `nix/README.md` in the public composition, or
`nix/burst/README.md` in the private development tree. Native source build accepts
explicit compiler, Node headers and output paths and requires no Git checkout.
The CLI and `tfsb-studio-service` remain package entry points on each target.
Native-runtime, filesystem and final release qualification remain separate gates.
