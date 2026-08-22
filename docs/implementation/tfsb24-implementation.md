# TFSB24 implementation: static preview and lifecycle hardening

## Status and scope

TFSB24 implements the final v0.2 engineering surface while the package remains
`0.1.0`. It does not implement release, publication, migration, `analyze`, a
runtime server, JavaScript preview behavior, schema expansion, configurable
limits, or new asset-identity derivation.

## Static preview

`tfsb preview [--root <path>] [--output <project-relative-directory>]
[--open] [--json]` writes a complete static gallery from one freshly captured
canonical snapshot. The default output is `.tfsb-preview` and the complete
generated set is `index.html`, `preview.css`, `assets/*.svg`, and
`.tfsb-preview.json`.

The page is fixed HTML/CSS with no JavaScript, active embedding, remote
resource, companion rendering, or runtime server. Input text is escaped for
all five HTML-sensitive characters, asset URL segments are percent-encoded,
and a fixed meta CSP permits only the local stylesheet and images. Geometry is
classified from the validated viewBox; fixed size strips and five fixed
background surfaces use classes rather than input-derived styles.

The marker is closed schema 1, fixed-order JSON plus LF with no timestamp,
absolute root, host, user, or environment data. Its asset and full generated
file inventory binds the configured output directory to exact hashes. Existing
targets must be non-symlink directories whose exact inventory revalidates
against a matching marker. The marker proves generated-directory ownership
only.

Preview execution uses private `WeakMap` authority behind a frozen public plan,
the shared `.tfsb.lock`, an owner-only sibling stage, durable file/directory
writes, staged marker/inventory reparse, canonical and target revalidation,
guarded backup/promotion, and rollback. Diagnostics distinguish rollback,
active-new-gallery cleanup, backup cleanup, and parent-fsync durability
failures. Portable Node APIs still leave the documented final
identity-check-to-rename race.

Build/install observations are supplemental. Unsafe or unowned build or
destination state is not followed and becomes `unavailable`; missing and
byte-different states remain successful preview results. Displayed SVG bytes
always come from fresh canonical serialization. `--open` runs only after
commit, never through a shell, and records `not_requested`, `skipped`,
`opened`, or `failed` without changing generation success.

## TFSB23 carry-forward corrections

- `LoadedProject` retains the exact canonical snapshot, including provenance
  bytes. Provenance/archive identity mapping no longer rereads live provenance,
  and expensive read-only operations revalidate before returning.
- Applying `fmt`, default build, install, and preview enforce the 128-asset
  mutation boundary before lock or stage creation. `fmt --check`, list, check,
  and read-only provenance diff retain complete read-only inspection above it.
- Build receipt and output inspection requires bounded non-symlink regular
  files read from one opened snapshot. Receipt size is capped at 512 KiB.
- Public receipt serialization strictly normalizes valid v2/v3 values, sorts
  maps, policy records, and destinations in UTF-8 byte order, and emits fixed
  two-space JSON plus LF.
- Machine arrays and diagnostics use deliberate UTF-8 ordering. Diagnostics
  have closed `error` severity, structural location fields, and adversarial
  path/token/stack/environment leak resistance.
- Reconciliation records carry `plannedAction` and `requiredAuthority` domain
  fields. New-asset collisions require rename authority and are not marked as
  resolution authority. This finalizes unreleased JSON schema v1 rather than
  migrating a shipped contract.
- Manifest archive diff preserves explicit asset IDs and reports an exact
  manifest filename change as `asset_identity` instead of substituting the
  canonical filename.

## Build and install authority

Build and install public plans are frozen inspection DTOs; copied,
deserialized, or forged plans cannot execute, and public field mutation does
not change private execution bytes or authority. Both operations coordinate
with canonical mutation through `.tfsb.lock`.

Build execution revalidates canonical and the absent/owned build target before
promotion, writes one complete durable stage, and uses guarded
backup/promotion/rollback. Install captures exact canonical, build output, and
destination snapshots; revalidates every destination before any replacement;
stages every output first; and retains complete reverse-order rollback and
backup-cleanup reporting. Neither operation follows receipt, output, or
destination symlinks.

## Verification surfaces

Focused Vitest coverage exercises marker ownership, deterministic bytes,
canonical-only images, HTML injection, CSP content, no-follow receipt/output
and destination handling, plan forgery, stale canonical/build/destination
authority, preview target races and rollback, deterministic receipt
serialization, reconcile machine authority, manifest filename identity,
diagnostic leak resistance, and the 128/129 boundary.

The integrated Terminal Nova test covers import with provenance, clean
reconciliation, v3 build, install, human and JSON inspection surfaces, all four
diff baselines, formatting, bundle, preview, semantic and formatting edits,
build/install/companion drift, rebuild/reinstall recovery, and exact companion
bytes. Development-only Playwright coverage loads the ten-asset production
gallery in Chromium, Firefox, and WebKit, rejects external requests and active
content, checks escaped malicious text, geometry and surface presentation,
local CSS/SVG loading, opaque companion display, drift badges, and non-empty
rendered images.

Final repository-wide verification, package inspection, and publication remain
dispatcher closeout responsibilities. No TFSB25 release work is included.
