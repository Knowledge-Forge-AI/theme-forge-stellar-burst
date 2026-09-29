# TFSB71P2-H Maintained Burst Helper Manifest & Handoff Contract

- **Document ID**: TFSB71P2-H-CONTRACT
- **Status**: Maintained P4 contract
- **Task Reference**: TFSB71P2-H (Burst helper producer/validator handoff for later Nebular P4)
- **Authority**: MUTATION_CAPABLE (owned paths: `tools/burst-helper-manifest.mjs`, `test/burst-helper-manifest.test.ts`, `docs/contracts/burst-helper-handoff.md`)
- **Parent Cycle**: TFSB71 Platform and Public-Source Readiness Track
- **Upstream Anchor**: [ADR 0023](../decisions/0023-theme-forge-product-family-and-public-composition.md)

---

## 1. Scope and Purpose

This contract defines the immutable handoff specification between **Theme Forge Stellar Burst** (producer) and **Theme Forge Nebular Fusion / Studio** (validator and consumer). In the upcoming Phase P4, Nebular consumes Burst as an installed helper service (`tfsb-studio-service`), executing under an authenticated Node.js runtime and invoking the native directory snapshot addon (`native-addon-posix-openat-v1`, ABI 1).

This specification guarantees that:
1. An installed Burst package root can be unambiguously inventoried and verified against an **externally authenticated expected manifest digest**.
2. No self-declared manifest acts as an independent trust anchor.
3. Target platform architectures are strictly mapped across the 12-cell matrix while preserving Intel macOS (`darwin-x64`).
4. Foreign targets, directory traversal, symlink escapes, missing resources, and tampered binaries are detected and rejected fail-closed.
5. No ambient `PATH` fallback is permitted for runtime binaries or service executables.
6. Existing Nebular trust anchors and Tauri sandbox boundaries remain uncompromised.

---

## 2. Security and Trust Model

### 2.1 The Principle of External Trust
A manifest embedded within an installed package (`burst-helper-manifest.json` or `manifest.json`) is an **inventory declaration**, NOT a root of trust. A rogue or compromised package could trivially forge its internal manifest to claim authenticity.

Therefore:
- The validator function (`validateBurstHelperManifest`) **requires** the caller to supply `expectedManifestDigest`.
- `expectedManifestDigest` must originate from an external, verified trust anchor (e.g., a Nix derivation store attribute, a cryptographically signed release receipt, or an authenticated build lockfile).
- Omitting, nullifying, or supplying an empty `expectedManifestDigest` results in an immediate fail-closed `TrustAnchorError`.

### 2.2 Prohibition of PATH Fallback
Resolution of the Node.js runtime or helper executables via the ambient shell environment (`PATH`, `which`, or bare command names like `"node"`) is strictly forbidden:
- An attacker with control of `PATH` could inject a modified Node binary or helper wrapper.
- All runtime paths must be provided as explicit, absolute filesystem paths.
- Relative paths, bare command names, or options requesting `usePathFallback` are rejected with `RuntimeSecurityError`.

### 2.3 Containment and Traversal Defenses
All files referenced by the manifest must reside strictly within the designated `packageRoot`:
- File paths are normalized to POSIX NFC relative paths without leading `/`, backslashes `\`, or `.` / `..` traversal components.
- Path length is bounded (maximum 512 bytes).
- Any intermediate or target symlink that resolves outside `packageRoot` (via `realpath`) triggers a `PathSecurityError`.
- Symlink ancestors above the package root are guarded during resolution.

### 2.4 Resource Immutability
All package resources (CLI scripts, service entrypoints, native addon shared libraries, and protocol schemas) are immutable. Modifying any byte, altering file size, or tampering with file permissions (mode) triggers a `TamperedResourceError`.

---

## 3. Target Platform Mapping

The contract binds the 12-cell product/platform matrix defined in the TFSB71 roadmap, maintaining exact parity with native prebuild directories and preserving existing Intel macOS artifacts:

| Canonical Target | Native Addon Artifact Directory | Platform / Arch | Status |
| :--- | :--- | :--- | :--- |
| `aarch64-darwin` | `darwin-arm64` | macOS Apple Silicon | Required (P-track cell) |
| `aarch64-linux` | `linux-arm64-gnu` | Linux AArch64 (glibc) | Required (P-track cell) |
| `x86_64-linux` | `linux-x64-gnu` | Linux x86_64 (glibc) | Required (P-track cell) |
| `darwin-x64` / `x86_64-darwin` | `darwin-x64` | macOS Intel | Preserved (Must not regress) |

Aliases accepted by the resolver:
- `aarch64-apple-darwin` → `darwin-arm64`
- `x86_64-apple-darwin` → `darwin-x64`
- Direct artifact names (`darwin-arm64`, `linux-arm64-gnu`, `linux-x64-gnu`, `darwin-x64`) map identity-safely to themselves.

Any unmapped, foreign, or unsupported target (e.g., `windows-x64`, `arm-linux-gnueabihf`, `freebsd`) is rejected with `ForeignTargetError`.

---

## 4. Bound Identities and Schema

The manifest schema is identified by `tfsb.burst-helper-manifest-v1` (version `1`).

### 4.1 Schema Structure
```json
{
  "schema": "tfsb.burst-helper-manifest-v1",
  "schemaVersion": 1,
  "target": "aarch64-darwin",
  "targetArtifact": "darwin-arm64",
  "package": {
    "name": "@knowledge-forge-ai/theme-forge-stellar-burst",
    "version": "0.5.0",
    "packageJsonSha256": "3a4b..."
  },
  "service": {
    "name": "tfsb-studio-service",
    "entrypoint": "dist/service-protocol/server-cli.js",
    "cliEntrypoint": "dist/cli.js",
    "sha256": "4c5d...",
    "size": 1234,
    "mode": 493
  },
  "native": {
    "backend": "native-addon-posix-openat-v1",
    "abi": 1,
    "artifact": "darwin-arm64",
    "path": "native/directory-snapshot/prebuilds/darwin-arm64/native-addon-posix-openat-v1.node",
    "sha256": "2f84...",
    "size": 53344,
    "mode": 493,
    "manifestPath": "native/directory-snapshot/prebuilds/darwin-arm64/manifest.json",
    "manifestSha256": "a1b2..."
  },
  "runtime": {
    "engine": ">=22",
    "runtimeKind": "node-service-helper-v1"
  },
  "protocol": {
    "name": "tfsb-studio-v1",
    "supportedVersions": ["1.0", "1.1", "1.2"],
    "1.0": {
      "inventorySha256": "96fd...",
      "requestsSha256": "5fa6...",
      "resultsSha256": "5b8f..."
    },
    "1.1": {
      "inventorySha256": "9d58...",
      "requestsSha256": "b5a1...",
      "resultsSha256": "dee9..."
    },
    "1.2": {
      "inventorySha256": "b620...",
      "requestsSha256": "e632...",
      "resultsSha256": "d625..."
    }
  },
  "files": [
    {
      "mode": 420,
      "path": "package.json",
      "sha256": "3a4b...",
      "size": 4134
    }
  ],
  "totals": {
    "bytes": 54321,
    "fileCount": 12,
    "inventoryDigest": "7e8f..."
  },
  "manifestDigest": "f0e1..."
}
```

### 4.2 Bound Components

1. **Package Identity**:
   - `package.json` must be present, valid JSON, declaring `@knowledge-forge-ai/theme-forge-stellar-burst`.
   - `packageJsonSha256` cryptographically binds package metadata.

2. **Service Executables**:
   - Primary service entrypoint: `dist/service-protocol/server-cli.js`.
   - CLI entrypoint: `dist/cli.js`.
   - Bound with exact SHA-256 digest, file byte size, and mode (executable).

3. **Native Addon**:
   - Backend identifier: strictly `native-addon-posix-openat-v1`.
   - ABI version: strictly `1` (`DIRECTORY_SNAPSHOT_BACKEND_ABI`).
   - Binary: `native/directory-snapshot/prebuilds/<artifact>/native-addon-posix-openat-v1.node`.
   - Manifest: `native/directory-snapshot/prebuilds/<artifact>/manifest.json`.
   - Cross-validation: Addon binary hash and size must match the values declared in `manifest.json`.

4. **Node.js Runtime**:
   - Declares engine requirement `node >= 22`.
   - When a specific runtime binary is bound, its absolute path, SHA-256 digest, byte size, and mode are verified.

5. **Protocol Suite**:
   - Namespace: `tfsb-studio-v1`.
   - Complete schema coverage across versions `1.0`, `1.1`, and `1.2`.
   - Binds `inventory.json`, `requests.schema.json`, and `results.schema.json` per version.
   - Binds common envelope `envelope.schema.json` and documentation `README.md`.

6. **Deterministic Inventory and Self-Digest**:
   - File list is canonically sorted by relative path in ASCII order.
   - `inventoryDigest` is the SHA-256 digest of canonical JSON representing the file array.
   - `manifestDigest` is the SHA-256 digest of the canonical JSON of the entire manifest omitting `manifestDigest`.

7. **Inventory Cross-Validation against Declared Components**:
   - The validator enforces bidirectional consistency between component metadata and the declared file inventory (`manifest.files`).
   - All required assets (`package.json`, `service.entrypoint`, `service.cliEntrypoint`, `native.path`, `native.manifestPath`, protocol version schemas, and common protocol files) must be present in `manifest.files`. Missing assets trigger `IncompleteResourceError`.
   - File digests, sizes, and executable permission modes declared in component blocks must match the corresponding entries in `manifest.files`. Any discrepancy triggers `TamperedResourceError`.
   - Target and artifact consistency is enforced: `manifest.native.artifact` and `manifest.targetArtifact` must both match the requested `targetArtifact`. Any mismatch triggers `ForeignTargetError`.
   - Runtime options (`nodePath`, `sha256`, `version`) are verified against bound runtime requirements when provided.

---

## 5. Error Handling and Diagnostics Matrix

All verification operations fail closed. Specific error classes and codes are defined:

| Error Class | Code | Cause |
| :--- | :--- | :--- |
| `TrustAnchorError` | `TRUST_ANCHOR_REQUIRED` | Missing, null, or empty `expectedManifestDigest`. |
| `ManifestDigestMismatchError` | `MANIFEST_DIGEST_MISMATCH` | Manifest's declared `manifestDigest` does not match `expectedManifestDigest`. |
| `ForeignTargetError` | `FOREIGN_TARGET` | Requested target is unsupported, or manifest target contradicts requested target. |
| `IncompleteResourceError` | `INCOMPLETE_RESOURCE` | Missing service entrypoint, native addon, native manifest, protocol schema, or inventory file. |
| `TamperedResourceError` | `TAMPERED_RESOURCE` | Mismatch in file SHA-256 digest, byte size, mode, or invalid manifest self-digest. |
| `PathSecurityError` | `PATH_SECURITY_VIOLATION` | Directory traversal (`..`), leading slash, non-relative path, or symlink escaping package root. |
| `RuntimeSecurityError` | `RUNTIME_SECURITY_VIOLATION` | Bare command `"node"`, relative runtime path, non-executable binary, or PATH fallback requested. |
| `AddonCompatibilityError` | `ADDON_COMPATIBILITY_ERROR` | Native addon ABI mismatch (`!= 1`) or backend mismatch (`!= native-addon-posix-openat-v1`). |

---

## 6. Programmatic and CLI Interface

Exported from `tools/burst-helper-manifest.mjs`:

```typescript
export interface ProduceOptions {
  packageRoot: string;
  target: string;
  runtime?: string | { nodePath?: string; version?: string };
  writeTo?: boolean | string;
}

export interface ValidateOptions {
  packageRoot: string;
  target: string;
  expectedManifestDigest: string; // Required external trust anchor
  runtime?: string | { nodePath?: string; version?: string };
  manifestPath?: string;
  manifest?: string | object;
}

export interface BurstHelperManifest {
  schema: string;
  schemaVersion: number;
  target: string;
  targetArtifact: string;
  package: { name: string; version: string; packageJsonSha256: string };
  service: { name: string; entrypoint: string; cliEntrypoint: string; sha256: string; size: number; mode: number };
  native: { backend: string; abi: number; artifact: string; path: string; sha256: string; size: number; mode: number; manifestPath: string; manifestSha256: string };
  runtime: { engine: string; runtimeKind: string; nodePath?: string; sha256?: string; size?: number; mode?: number; version?: string; v8?: string; target?: string };
  protocol: { name: string; supportedVersions: string[]; [key: string]: unknown };
  files: Array<{ path: string; sha256: string; size: number; mode: number }>;
  totals: { bytes: number; fileCount: number; inventoryDigest: string };
  manifestDigest: string;
}

export interface VerifiedHelperHandoff {
  ok: true;
  manifestDigest: string;
  target: string;
  targetArtifact: string;
  package: { name: string; version: string; root: string };
  service: { name: string; entrypointPath: string; cliPath: string; sha256: string; size: number; mode: number };
  native: { backend: string; abi: number; artifact: string; addonPath: string; manifestPath: string; sha256: string; size: number; mode: number };
  runtime: object;
  protocol: { name: string; supportedVersions: string[]; protocolDir: string };
  totals: { bytes: number; fileCount: number; inventoryDigest: string };
  files: Array<{ path: string; sha256: string; size: number; mode: number }>;
  verifiedFileCount: number;
}

export function produceBurstHelperManifest(options: ProduceOptions): Promise<BurstHelperManifest>;
export function validateBurstHelperManifest(options: ValidateOptions): Promise<VerifiedHelperHandoff>;
```

### CLI Invocations
```bash
# Produce manifest for a package root
node tools/burst-helper-manifest.mjs --produce --package-root /path/to/burst --target aarch64-darwin --write

# Validate package against an authenticated expected digest
node tools/burst-helper-manifest.mjs --validate --package-root /path/to/burst --target aarch64-darwin --expected-digest <sha256>
```

---

## 7. Operational Boundaries and P4 Successor Responsibilities

1. **Burst Producer / Validator Scope**:
   - Owns packaging verification, native prebuild validation, protocol schema verification, and deterministic inventory creation.
   - Operates strictly within the 3 authorized files: `tools/burst-helper-manifest.mjs`, `test/burst-helper-manifest.test.ts`, and this document.
   - Does not touch or modify existing Tauri Rust backends, Nebular UI components, or historical release manifests.

2. **Nebular Studio (P4) Responsibilities**:
   - Nebular P4 receives the verified handoff descriptor produced by `validateBurstHelperManifest`.
   - Nebular P4 owns child process spawning, JSON-RPC session handshake (`initialize` / `shutdown`), Tauri IPC command routing, and error telemetry.
   - Nebular P4 supplies `expectedManifestDigest` from its build-time Nix derivation inputs or locked configuration.

## Package-local dependency closure

A P4 helper handoff must stage all declared runtime dependencies below the helper
root's `node_modules`; production and validation include their bytes and modes in
the authenticated inventory. A normal npm install may hoist dependencies outside
the Burst package directory. That package root alone is not a complete helper
handoff and must fail this producer until P4 assembles a closed, authenticated
resource tree (or consumes the already closed first-party Nix output). npm product
qualification remains independent. P4 must also authenticate the complete Node
runtime and its required system-library closure before launch. The manifest is
inventory, not publication approval or a replacement for Nebular trust anchors.
