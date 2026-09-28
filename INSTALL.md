# Theme Forge Family Installation Guide

**Next Nebular candidate: publication is blocked pending artifact fixes.**
Local native payload and npm installation evidence exists for all three intended
targets; the complete public wrapper remains unqualified. Historical installation
instructions below describe published versions. Candidate support and limitations
are described separately below.

This document provides installation, verification, and distribution instructions for all five products in the Theme Forge family:
1. **Theme Forge Stellar Burst** (`tfsb`, `tfsb-studio-service`)
2. **Theme Forge Stellar Loom** (`tfsl`, `tfsl-batch`)
3. **Theme Forge Solar Sail** (`tfss`)
4. **Theme Forge Nebular Fusion** (`tfnf`)
5. **Starlight Theme Terminal Nova** (Nova theme)

---

## 1. Distribution & Packaging Overview

| Product | Version | Primary Channels | Binary / Entry Point | Code Signing & Security Status |
| :--- | :--- | :--- | :--- | :--- |
| **Theme Forge Stellar Burst** | `0.5.0` | npm, Homebrew Tap, GitHub Releases | `tfsb`, `tfsb-studio-service` | Published tarball checksum verified; changed next-release bytes need a new version |
| **Theme Forge Stellar Loom** | `0.3.0` | npm, Homebrew Tap, GitHub Releases | `tfsl`, `tfsl-batch` | Published tarball checksum verified; next-release candidate differs |
| **Theme Forge Solar Sail** | `0.1.0` | npm, Homebrew Tap, GitHub Releases | `tfss` | Published tarball checksum verified; next-release candidate differs |
| **Theme Forge Nebular Fusion** | `0.4.0` published; `0.6.0` source candidate | npm wrapper + platform packages, owned Nix flake, GitHub references; next-release Homebrew Cask pending | `tfnf`, native GUI | Retained macOS ad-hoc signature checks; no Developer ID or notarization claim |
| **Starlight Theme Terminal Nova** | `0.3.0` | npm; GitHub source, tag and release references | Importable Starlight theme | npm-only among package-manager products; no CLI, VSIX, Homebrew or Nix package claim |

The unreleased source checkpoint assigns Burst 0.6.0, Loom 0.4.0, Solar Sail 0.2.0,
and Nebular (wrapper and platform packages) 0.6.0. These are not installation
targets yet: release artifacts have not been built or qualified.
The published versions and historical verification examples
below retain their original identities.

---

## 2. Channel 1: npm CLI Packages

All CLI tools are published under the `@knowledge-forge-ai` npm scope.

### Global Installation via npm

```bash
# Theme Forge Stellar Burst
npm install -g @knowledge-forge-ai/theme-forge-stellar-burst

# Theme Forge Stellar Loom
npm install -g @knowledge-forge-ai/theme-forge-stellar-loom

# Theme Forge Solar Sail
npm install -g @knowledge-forge-ai/theme-forge-solar-sail

# Theme Forge Nebular Fusion (published 0.4.0: Apple Silicon GUI & CLI companion)
npm install -g @knowledge-forge-ai/theme-forge-nebular-fusion
```

### Verification

```bash
tfsb --version
tfsl --version
tfss --version
tfnf --version
```

> **Historical Nebular Fusion 0.4.0 npm behavior**: `@knowledge-forge-ai/theme-forge-nebular-fusion` uses an optional platform dependency on `@knowledge-forge-ai/theme-forge-nebular-fusion-darwin-arm64`. On macOS Apple Silicon systems, npm installs the platform package containing the native bundle. On unsupported architectures, the CLI wrapper fails gracefully with explicit platform requirements.

---

## 3. Channel 2: Homebrew Tap

Formulas are hosted in the project-maintained third-party Homebrew tap: `Knowledge-Forge-AI/homebrew-tap`.

### Adding the Tap

```bash
brew tap Knowledge-Forge-AI/homebrew-tap
```

### Installing Available CLI Formulae

```bash
# Install Stellar Burst
brew install Knowledge-Forge-AI/tap/theme-forge-stellar-burst

# Install Stellar Loom
brew install Knowledge-Forge-AI/tap/theme-forge-stellar-loom

# Install Solar Sail
brew install Knowledge-Forge-AI/tap/theme-forge-solar-sail
```

### Tap Boundaries & Deliberate Withholdings

- **Nova Theme Formula**: Not part of owner distribution policy. Starlight Theme Terminal Nova is an importable Starlight theme, distributed through npm with GitHub references.
- **Nebular Fusion Cask**: **Withheld** pending qualified native artifacts and installed GUI evidence. Ad-hoc signing is acceptable for the third-party tap; Developer ID and notarization are optional later improvements, not release prerequisites. Gatekeeper may require manual Privacy & Security → Open Anyway approval. Installation must preserve quarantine and must not bypass Gatekeeper.

---

## 4. Channel 3: Owned Nix Flakes

Theme Forge provides Nix integration for reproducible desktop and developer environments.

The maintained source-build flakes cover `aarch64-darwin`, `aarch64-linux` and
`x86_64-linux`. Retained package/check/installed-contract evidence covers all
three, with AMD64 translated/emulated on Apple Silicon. Those Nix outputs are
distinct from portable npm payloads. Current-source linkage and publication of
the selected owned flake remain pre-publication gates. The owned maintained
flake satisfies the Nix distribution objective; no further official nixpkgs
acceptance campaign is planned. The old submission is preserved unchanged.

### Stellar Burst public source checkout

The Burst public composition exposes Burst commands only:

```bash
nix run .#tfsb -- --help
nix profile install .#theme-forge-stellar-burst
```

Run these from a selected Burst source revision containing its maintained flake.
The future publication must authenticate and pin that revision. Loom and Solar
have their own standalone source flakes.

### Nebular development source checkout only

The maintained monorepo root flake exposes `tfnf` and
`theme-forge-nebular-fusion` on all three systems. **These attributes are absent
from the Burst public flake.** The following commands require that monorepo
checkout; they are not installation commands for the public Burst repository:

```bash
nix run .#tfnf -- --version
nix profile install .#theme-forge-nebular-fusion
```

A public Nebular flake reference remains subject to source linkage and publication
qualification; no currently installable public reference is asserted here.

### Preserved Upstream Submission

A historical `by-name` derivation remains at:
`pkgs/by-name/th/theme-forge-nebular-fusion/package.nix`

Its presence is not an acceptance or current-platform qualification claim.

---

## 5. Channel 4: GitHub Release Bundles & Integrity Verification

Official release tarballs and provenance attestations are hosted on GitHub Releases:
`https://github.com/Knowledge-Forge-AI/theme-forge-stellar-burst/releases`

### Asset Verification

Check the actual release asset inventory for SHA-256 digests and any Sigstore
provenance bundle. A checksum establishes byte identity, not signing or
notarization. Where the corresponding bundle exists, verification can use:

```bash
# Verify Stellar Burst release tarball checksum
echo "1222b613b119f785061ac61e25eccf3af9810f2b118a4669481c23cd390c661e  knowledge-forge-ai-theme-forge-stellar-burst-0.5.0.tgz" | sha256sum -c -

# Verify Sigstore cosign bundle (if cosign installed)
cosign verify-blob \
  --bundle theme-forge-stellar-burst-0.5.0.sigstore.json \
  --certificate-identity-regexp "https://github.com/Knowledge-Forge-AI/theme-forge-stellar-burst/" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  knowledge-forge-ai-theme-forge-stellar-burst-0.5.0.tgz
```

### Software Bill of Materials (SBOM)

Release bundles must bind their actual machine-readable SBOMs to selected bytes.
Existing asset names vary by product; examples include:
- SPDX format: `burst-package.spdx.json`, `source-files.spdx.json`
- CycloneDX format: `burst-package.cdx.json`

---

## 6. Local Development Bootstrap

For developers contributing to or testing the monorepo locally:

```bash
# 1. Clone repository
git clone https://github.com/Knowledge-Forge-AI/theme-forge-stellar-burst.git
cd theme-forge-stellar-burst

# 2. Install Node.js dependencies
npm ci

# 3. Verify test file inventory synchronization
npm run check:inventory

# 4. Run CI test suites
npx vitest run test/ci/

# 5. Check workflow semantics across all 5 public products
node tools/public-composition/validate-workflow-semantics.mjs

# 6. Evaluate release train packaging and publication authority
node tools/ci/release-train-authority.mjs
```


## Next-release Nebular GUI candidate

Retained GUI evidence covers native Apple Silicon macOS, native-architecture
Linux ARM64 in a VM/container, and translated/emulated Linux AMD64 on Apple
Silicon. It does not qualify native AMD64 hardware. Observed vector workflows
were accepted on macOS and Linux ARM64. A later ARM64 session reports seven
passes, including select readability, but its scene/SVG collection is incomplete.
AMD64 has seven accepted operator observations with a missing post-session SVG
limitation. Command-line probes alone do not qualify the GUI. These records do
not expand historical 0.4.0 support claims.

- **Native layout:** macOS retains an ad-hoc-signed `.app` archive. Linux raw
  executable/resources archives are provisional pending comparison with AppImage.
  The proposed Linux baseline is Ubuntu 24.04 GNU/glibc with GTK 3/GLib,
  WebKitGTK 4.1 and a usable desktop display session. Final graphics, TLS and
  dialog dependencies still require the native feature/dependency audit.
- **npm:** the wrapper selects exactly one optional `darwin-arm64`, `linux-arm64`
  or `linux-x64` platform package with matching `os`, `cpu` and version metadata.
  Complete payloads must carry authenticated helpers/resources without a first-run
  download or ambient compiler/runtime fallback. All three platforms have real
  local-tarball installation evidence using platform-specific private wrappers.
  The complete family wrapper and automatic optional-dependency selection remain
  unqualified. Do not publish the private canary wrappers.
- **Nix:** source-built Rust/Tauri, frontend and project helpers are required for
  all three systems. Intended commands are `nix run .#tfnf` and
  `nix profile install .#theme-forge-nebular-fusion` in the monorepo checkout
  described above, not the public Burst checkout. Retained outputs exist;
  their exact source authorities and consumer limits must be preserved.
- **Homebrew:** after qualification and a separately authorized publication, the
  intended command is
  `brew install --cask Knowledge-Forge-AI/tap/knowledge-forge-ai-theme-forge-nebular-fusion`.
  This command remains unqualified and unpublished. The local generator accepts three authenticated native
  artifacts. Ad-hoc macOS signing is permitted, with manual Open Anyway approval
  where Gatekeeper requires it; no quarantine removal is performed.
- **GitHub:** the candidate layout comprises three native GUI archives, the npm
  wrapper archive, three npm platform archives and one public source archive
  (eight artifacts), plus checksums and the existing SBOM/provenance/signing
  evidence. Neither complete artifact assembly nor publication is claimed.

## Next-release multi-platform native build

The next Burst candidate adds GNU/glibc Linux ARM64 (`linux-arm64-gnu`) alongside
Darwin ARM64, GNU Linux x64 and preserved Darwin x64. npm retains one package
carrying authentic native prebuilds; normal installation selects the local target
without downloading project binaries at first launch. This is candidate support,
not a revision of published v0.5.0 platform claims.

Build from public source with Nix using `nix build .#theme-forge-stellar-burst`.
See `nix/README.md` in the public composition, or
`nix/burst/README.md` in the private development tree. Native source build accepts
explicit compiler, Node headers and output paths and requires no Git checkout.
The CLI and `tfsb-studio-service` remain package entry points on each target.
Native-runtime, filesystem and final release qualification remain separate gates.


## Next-release Loom and Solar distribution

Loom and Solar retain one portable npm package each. The next public source
composition includes maintained first-party flakes for `aarch64-darwin`,
`aarch64-linux` and `x86_64-linux`, compiling TypeScript with locked inputs.
These are candidate interfaces, not claims about files in existing release tags.

Loom installs both `tfsl` and the EOF-framed `tfsl-batch`. Solar paired-profile
v2 remains a library API. Published Formula references remain pinned to their
historical bytes; unpublished candidate artifacts require separate hashes and
a later version/release decision.
