# Terminal Nova Integration & Migration Notes

This document records the architectural integration findings and migration guidance from qualifying **Theme Forge Stellar Burst (TFSB)** against its flagship consumer, **Theme Forge Terminal Nova** (`Knowledge-Forge-AI/theme-forge-terminal-nova` at commit `461d9add96ed6c04b341e31305697a9046eed1a8`).

## Flagship Consumer Placement Topology

Terminal Nova uses a multi-tier asset distribution topology that exercises TFSB's full configuration model:

1. **Build Directory (`brand/dist`):**
   - Serves as the wholesale compiler output directory.
   - Contains all 10 canonical production SVGs and the cryptographic `.tfsb-build.json` receipt.
   - Protected trees (`src`, `docs`, `test`) are intentionally prohibited as `build.directory` to prevent accidental wholesale replacement of project source trees.

2. **Application Install Destinations (`docs/src/assets/brand/`):**
   - Six core brand assets (mark, horizontal lockup, stacked lockup in both light and dark variants) are installed as individual files into Astro source trees.
   - Install destinations inside source/application trees are fully permitted and tracked for drift.

3. **Public Favicon Destinations (`docs/public/`):**
   - Favicons are installed into public root directories.
   - Supports multi-destination distribution: `favicon-on-light.svg` is installed to both `docs/public/favicon-on-light.svg` and `docs/public/favicon.svg`.
   - `favicon-on-dark.svg` is installed to `docs/public/favicon-on-dark.svg`.

4. **Zero-Destination Canonical Marks:**
   - Monochrome marks (`mark-monochrome-dark.svg`, `mark-monochrome-light.svg`) are compiled into `brand/dist` but have zero install destinations configured, maintaining them as canonical build outputs without polluting application trees.

5. **Companion Documents:**
   - The brand README (`README.md` in the archive) is declared as an opaque companion document in `[[companion]]` and installed byte-for-byte to `README-BRAND.md`.

---

## Consumer Audit Findings & Discovered Issues

During qualification of TFSB against the Terminal Nova repository, the following consumer-side discrepancies and migration steps were identified:

### 1. Stale Favicon Reference in `docs/astro.config.ts`
- **Finding:** At audited commit `461d9add96ed6c04b341e31305697a9046eed1a8`, `docs/astro.config.ts` contains `favicon: 'src/assets/theme-forge-terminal-nova.svg'`. The repository's asset tree houses SVGs under `docs/src/assets/brand/`, while TFSB installs favicon outputs under `docs/public/` (`docs/public/favicon-on-light.svg` and `docs/public/favicon.svg`).
- **Guidance:** The subsequent Terminal Nova migration phase must update `favicon` in `docs/astro.config.ts` to the framework-correct reference for the intended installed favicon.

### 2. Stale Hero Asset Reference in `docs/src/content/docs/index.mdx`
- **Finding:** At audited commit `461d9add96ed6c04b341e31305697a9046eed1a8`, `docs/src/content/docs/index.mdx` contains:
  ```yaml
  image:
    file: ../../assets/dssh.svg
  ```
  This is the inherited/stale upstream hero asset reference.
- **Guidance:** The subsequent Terminal Nova migration phase must replace `../../assets/dssh.svg` with the appropriate approved Nova Ingot asset (such as `../../assets/brand/theme-forge-terminal-nova-horizontal-on-dark.svg` or an approved lockup).

### 3. Safe First-Build Ownership Migration Sequence for `brand/dist`
- **Finding:** Existing checkouts of Terminal Nova contain pre-existing SVG files in `brand/dist` without a `.tfsb-build.json` receipt. TFSB fails closed with `BUILD_UNOWNED_DIRECTORY` when encountering a non-empty build directory lacking an authentic receipt.
- **Guidance:** Follow this safe 9-step migration sequence during consumer adoption:
  1. Create/import the actual current Terminal Nova SVG bundle and legal README into `.tfsb` (`tfsb import <archive.zip> --companion README.md`).
  2. Inspect and verify the generated human-readable TOML files (`.tfsb/assets/*.toml`, `.tfsb/project.toml`) and companion content (`.tfsb/companions/README.md`).
  3. Configure the known install topology and companion rules in `.tfsb/project.toml`.
  4. Retire/disable the legacy Python SVG build and install scripts.
  5. Move aside or backup the legacy generated `brand/dist` directory (e.g. `mv brand/dist brand/dist.legacy-backup`).
  6. Run `tfsb build` so TFSB creates an owned `brand/dist` containing compiled SVGs and `.tfsb-build.json`.
  7. Run `tfsb install` to write all configured asset and companion destinations across the repository.
  8. Run `tfsb check` to verify zero drift between source TOML, build artifacts, and installed destinations.
  9. Clean up the migration backup only after complete verification.
