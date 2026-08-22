# TFSB21 bounded provenance and reconciliation implementation

## Implemented surface

TFSB21 adds opt-in deterministic import provenance, a pure paired-checkpoint
classifier for assets and companions, complete-tree reconciliation planning,
exact per-record resolution/rename/removal authorities, and a recoverable
canonical `.tfsb` transaction. The CLI surface is `import --record-provenance`
and read-only-by-default `reconcile`; no deferred bundle, manifest, diff, fmt,
JSON, preview, analyze, schema-2, or release-version surface is included.

The public package API exposes strict provenance parse/serialize functions,
the frozen asset and companion digest functions, the paired-checkpoint
classifier, opaque typed reconciliation plans, validated plan execution, and
the high-level project operation. Filesystem snapshots and raw transaction
implementation structures remain internal.

TFSB21R1 hardens those internals without expanding the command surface.
Provenance import now owns an authoritative expected-absent snapshot before
archive work; reconciliation decodes all canonical semantics from one captured
snapshot and revalidates it before returning; plan execution derives blockers
and change authority only from private planner state while public DTOs are
frozen. Archive inspection adds a fixed 128 MiB raw-file ceiling and validates
EOCD/central-directory structure before bounded whole-file hashing. Initial
promotion durability diagnostics no longer claim a backup that never existed.

## Provenance and reconciliation contract

`.tfsb/provenance.json` uses kind `tfsb-import-provenance`, schema version 1,
fixed record fields and ordering, two-space JSON, UTF-8, and one final LF.
Asset semantic digests use `tfsb-asset-toml-v1`; companion digests cover exact
opaque bytes. Provenance contains no archive filesystem path, project absolute
path, host, user, environment, retained archive, or timestamp.

One unresolved active record blocks the entire apply. Canonical resolution
records stable accepted divergence or absence; archive resolution records
aligned checkpoints. Omission is reporting evidence only. Renames and removals
require exact directives. The complete next project is limited to 128 assets
before lock acquisition or stage creation.

## Transaction and recovery boundary

Mutation uses an exclusive project-root sibling `.tfsb.lock`, an exact
canonical snapshot, same-parent owner-only stage and backup trees, supported
file/directory fsync operations, precommit canonical/archive revalidation, and
a complete-directory replacement sequence. Handled failures restore the old
tree when possible. Rollback or post-promotion cleanup failures retain named
project-relative residue and report a stable recovery diagnostic; no automatic
recovery is attempted.

## TFSB22 manifest-identity handoff

Manifest-assisted import may preserve a validated explicit asset ID that
differs from the SVG filename stem. Bundle/reconciliation integration must not
send such a tracked entry back through basename-derived identity: doing so can
create a mismatched TOML path, a duplicate asset, or a stale install reference.
Manifest identity becomes authoritative only after the manifest and every
referenced byte validate. Unmanifested third-party archives continue to use
basename-derived identity. TFSB21R1 implements none of the manifest surface.

## Qualification scope

Focused executable coverage includes the complete paired-checkpoint table,
deterministic and strict provenance, golden digests, architecture scenarios
1–8, 16, and 17, accepted divergence and absence, canonical missing state,
partial/malformed provenance, exact asset and companion removals, selection and
portable collisions, unannounced moves plus explicit continuity, 128/129 asset
boundaries, archive and canonical concurrent change, lock contention, stage and
swap failures, successful and failed rollback, backup cleanup failure, orphan
recovery discovery, and failed initial provenance import. TFSB21R1 adds
authoritative absent-import seams, coherent read-only planning, post-plan apply
revalidation, public-plan mutation/forgery probes, raw archive size/hash-order
probes, exact-ceiling archive evidence, and initial/replacement promotion
durability diagnostics. Existing schema-1 commands and fixtures remain in the
full regression suite.

The phase uses only checked-in Terminal Nova qualification fixtures and
synthetic test data. External dogfood checkouts are not implementation inputs.

## Integrated candidate verification

The implementation-stage integrated candidate passed `npm run typecheck`, all
16 Vitest files / 211 tests, `npm run build`, and `npm audit --omit=dev` with
zero vulnerabilities. `npm pack --dry-run --json` reported the intentional
0.1.0 package payload (53 entries) containing package documents and `dist/`
only; it contains no `tools/`, test fixture, temporary transaction, package
archive, or external dogfood content. Playwright was not run because this phase
does not change the rendered SVG or preview contract. Dispatcher closeout owns
the final resulting-state rerun and publication disposition.
