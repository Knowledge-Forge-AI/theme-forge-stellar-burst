# TFSB33 — Migration, Explicit Normalization, and Provenance Schema 2

## Objective

Implement the complete schema-1-to-schema-2 migration and explicit
normalization authority described by the
[v0.3 architecture](../architecture/v0.3.md),
[ADR 0005](../decisions/0005-schema-2-accessibility-and-presentation.md),
[ADR 0006](../decisions/0006-productized-analyze-and-normalization.md), and
[ADR 0007](../decisions/0007-migration-and-provenance-compatibility.md).

This phase owns migration, explicit safe normalization, provenance schema 2,
schema-2 initial import with optional provenance, and schema-2 reconcile. It
must preserve the accepted TFSB32 schema-2 core and the corrected TFSB32R1
analyzer/profile parity contract. It does not own collection identity,
directory import/reconcile, raised limits, unsafe-content transformation, or
release work.

This document defines product scope and acceptance. The dispatcher owns stage
transitions, review checkpoints, reviewer selection, and Git publication
policy.

## Authority and current baseline

1. Work only in the dispatcher-selected development checkout. Fetch refs and
   tags, require a clean worktree, and bind the live semantic starting state.
   Historical Git identities are evidence, not a substitute for semantic
   checks.
2. Require package version `0.2.0`, the frozen schema-1 parser/writer and digest
   basis, the accepted TFSB32 schema-2 core, parser/canonical-byte direct
   schema-2 import, and the `ROOT_ALREADY_INITIALIZED` guard.
3. Use the corrected
   [TFSB32R1 analyzer baseline](../evaluations/v0.3-analyzer-dogfood-baseline.md)
   as the compatibility oracle for normalization planning. Its current machine
   artifact digest is
   `9651f98cee47ff4026ad3de324c52bb34cfbc8925b2d4eed8e5a07ebfa40a2fd`.
4. Run the repository-owned starting gate before editing. Stop on a material
   semantic or verification divergence rather than resetting, rebasing,
   rewriting, or guessing.

Analyzer compatibility remains independent from identity, legal and
redistribution review, normalization authority, resource limits, source-tree
safety, and lifecycle readiness. A normalizable classification grants no
mutation authority by itself.

## Preserved contracts

TFSB33 must preserve all of the following:

- frozen schema-1 TOML, SVG, parser, writer, diagnostics, lifecycle behavior,
  and `tfsb-asset-toml-v1` digest semantics;
- TFSB32 direct-only canonical schema-2 import, including real
  `parseSvgV2` authority and exact canonical SVG byte equality;
- TFSB32R1 inventory-first analyzer source-safety behavior and closed
  common-v0.3 grammar;
- the 128-asset and 32-MiB mutation boundaries;
- existing confinement, no-follow, snapshot, lock, transaction, rollback,
  collision, archive, manifest, and companion-byte protections;
- homogeneous project schemas outside the one atomic migration transaction;
  and
- package version `0.2.0` and the immutable public v0.2.0 release.

TFSB33 must not add directory import/reconcile, collection identity, higher
limits, unsafe-content normalization, dependency changes, or release work.

## Required product scope

Implement all thirty items below as one coherent bounded phase.

1. Define provenance schema 2 with explicit digest bases for raw archive
   source, canonical schema-specific TOML, cross-schema SVG output,
   normalization policy, and migration transitions.
2. Implement truthful absent, partial, and complete provenance migration
   behavior without inventing missing archive observations.
3. Freeze `tfsb-svg-output-v1` and prove cross-schema equality over exact
   canonical SVG bytes.
4. Implement read-only `tfsb migrate --check [--json]` with a complete,
   deterministic whole-project plan.
5. Implement transactional `tfsb migrate [--json]` with the same plan and
   truthful applied disposition.
6. Migrate a whole schema-1 project to homogeneous schema 2 in one transaction;
   never expose an active mixed-schema project.
7. Require exact schema-1/schema-2 canonical SVG byte equality for every
   migrated asset before promotion.
8. Preserve every companion byte exactly through planning, staging,
   promotion, rollback, and readback.
9. Mark existing build receipts source-stale after migration without an
   implicit build, install, preview, or other output refresh.
10. Implement the exact `exact-common` normalization policy and no broader
    policy.
11. Define normalization-map schema 1 as the closed explicit authority input.
12. Canonically serialize normalization-map schema 1 with deterministic key,
    record, and path ordering and one terminal LF.
13. Freeze `tfsb-normalization-policy-v1` as SHA-256 over the exact canonical
    policy/map bytes specified by the architecture.
14. Require explicit decorative or consumer-labelled authority for unlabeled
    input; never infer accessible prose or intent from filenames or asset IDs.
15. Normalize title-only input exactly to schema-2 `labelled`, preserving the
    title and creating no fabricated description.
16. Map accepted root presentation into typed schema-2 `[presentation]` and
    element/group overrides with the exact recorded normalization facts.
17. Canonicalize only the supported namespace and SVG version forms owned by
    the accepted policy.
18. Normalize asset-local `xlink:href` plus its namespace to canonical SVG 2
    `href`; never normalize an external or ambiguous reference.
19. Expand only accepted geometry numeric defaults and record that operation
    in the ledger.
20. Complete a single rect corner radius to the exact paired schema-2 corner
    representation and record that operation.
21. Normalize definition category order only where ADR 0005 already authorizes
    it, preserving source-relative within-kind order.
22. Produce a complete deterministic normalization dry-run ledger before any
    mutation, including source classification, explicit authority consumed,
    typed operations, before/after digests, and final disposition without raw
    source text.
23. Extend schema-2 initial archive/manifest import with optional truthful
    provenance recording while retaining canonical direct import without that
    option.
24. Implement schema-2 reconcile using explicit stored normalization authority
    or an exact re-supplied policy/map; never reuse unstored CLI intent.
25. Integrate normalized raw-source and canonical semantic truth into archive
    diff without collapsing the two comparisons.
26. Apply the same manifest verification, identity, normalization, and
    provenance rules to manifest import before planning writes.
27. Keep bundle round trips truthful: bundles serialize canonical semantics and
    do not claim to reproduce noncanonical source XML or absent provenance.
28. Accept an old unchanged archive against its preserved schema-1 checkpoint
    while representing the migrated schema-2 canonical state as explicit,
    proven SVG-equivalent divergence.
29. Treat a changed archive as fresh source under the stored or re-supplied
    normalization authority and route real paired-checkpoint conflicts without
    convergence shortcuts.
30. Harden migration, normalization, import, and reconcile transactions for
    snapshot changes, lock contention, concurrent target creation, staging and
    promotion failure, rollback failure, and exact recovery-residue reporting.

## Provenance schema 2

Provenance must distinguish observations rather than collapsing them:

- `archive` is absent/null or an exact raw-source checkpoint plus its
  schema-specific canonical relation;
- `migration` records v1/v2 canonical digest bases, before/after digests,
  `tfsb-svg-output-v1` before/after digests, equality, and the exact migration
  resolution;
- `normalizationPolicy` is absent/null unless an exact canonical policy/map
  was consumed and records its `tfsb-normalization-policy-v1` digest; and
- every digest field names its basis explicitly.

Migration behavior is closed:

1. Absent provenance creates only truthful migration/SVG equality evidence;
   archive remains absent.
2. Partial provenance preserves each existing archive checkpoint exactly;
   untracked assets remain archive-absent while all assets gain migration
   evidence.
3. Complete provenance preserves every archive relation and adds an independent
   migration transition per asset.

Unknown versions, bases, incomplete records, invalid digests, mismatched
relations, and unrepresentable transitions fail before mutation.

## Migration contract

`migrate --check` and apply must share one planner. The plan is complete and
sorted by project-relative path. It reports project schema transition, asset
and companion counts, before/after bases and digests, SVG equality, provenance
transition, receipt-staleness effects, and whether mutation was applied. It
contains no raw TOML, SVG, accessibility text, companion bytes, absolute paths,
or environment data.

Apply must parse and validate the complete schema-1 project, generate all
schema-2 files and provenance in staging, reparse and revalidate staged bytes,
prove every SVG output equal, revalidate source snapshots, then promote the
whole project atomically under the existing transaction authority. Any failure
preserves the active schema-1 project or reports exact recoverable residue.

## Explicit normalization contract

The `exact-common` policy may consume only accepted common-v0.3 content and the
explicit authority required for accessibility. It must reject all unsafe
content and every unsupported construct; normalization may not downgrade either
classification. The analyzer supplies inventory and a compatibility plan, but
the real schema-2 parser/validator and canonical writer remain semantic output
authorities.

Each source file receives an exact dry-run ledger before writes. The ledger
must bind the source snapshot, common-v0.3 result, explicit normalization-map
entry when required, ordered typed operations, canonical output digests, and
policy digest. Applying the ledger must reproduce those exact outputs or stop.

## Import, reconcile, diff, manifest, and bundle interaction

- Canonical direct schema-2 import remains parser/canonical-byte based and does
  not require analyzer normalization authority.
- Noncanonical initial import requires the explicit `exact-common` policy and,
  where applicable, a normalization map. Optional provenance records only
  observations actually made.
- Reconcile requires the exact stored policy identity or an exact matching
  re-supplied policy/map. Changed authority is a new decision, not implicit
  continuity.
- Archive diff reports raw source classification and normalized canonical
  semantic change independently.
- Manifest import verifies signed/declared bytes, paths, IDs, and digests before
  normalization planning and preserves the existing mutation bounds.
- Bundle output contains canonical project semantics and truthful provenance;
  it does not reconstruct or claim original noncanonical source bytes.

## Terminal Nova acceptance fixture

Acceptance must include whole-project migration of the complete Terminal Nova
schema-1 fixture. For every asset:

1. serialize the starting schema-1 model with the frozen writer;
2. migrate the whole project;
3. parse the resulting schema-2 asset and serialize it with the schema-2
   writer;
4. require exact schema-1/schema-2 SVG byte equality and
   `tfsb-svg-output-v1` digest equality; and
5. verify exact companion-byte preservation and stale, unrefreshed build
   receipts.

Run the fixture independently for absent, partial, and complete provenance.
Verify truthful old-unchanged-archive accepted divergence and changed-archive
conflict behavior in each applicable state. No fixture may depend on copied
external dogfood source.

## Required verification

Use focused tests while implementing, then run the repository-owned integrated
gate from the resulting state. Evidence must include:

- canonical normalization-map and policy-digest vectors;
- migration check/apply JSON and human-output contracts;
- unchanged schema-1 golden and digest vectors;
- cross-schema SVG equality for every shared schema-1 shape and Terminal Nova
  asset;
- absent/partial/complete provenance parsing, migration, serialization, and
  readback;
- canonical direct import and normalization-required import separation;
- schema-2 import/reconcile/archive-diff/manifest/bundle interactions;
- 128-asset and 32-MiB exact-boundary/one-over cases;
- transaction, rollback, concurrency, snapshot, confinement, and residue
  cases;
- unchanged analyzer source-safety and corrected compatibility-oracle tests;
- `npm run typecheck`, `npm test`, `npm audit --omit=dev`,
  `npm run test:visual`, `npm pack --dry-run --json`, and `git diff --check`;
  and
- no dependency, package-version, or unintended package-payload drift.

Static checks are not runtime or transaction evidence. Each lifecycle claim
requires an executable test at the real filesystem/archive boundary.

## Stop conditions

Stop rather than improvise if:

- exact schema-1/schema-2 SVG equality fails for any accepted migration;
- a requested normalization is not already authorized by ADR 0005, ADR 0006,
  ADR 0007, and `exact-common`;
- normalization would require accepting or transforming unsafe content;
- provenance cannot represent an observed absent, partial, or complete state
  truthfully;
- a material analyzer defect outside the corrected accepted profile appears;
- the transaction cannot preserve the complete old schema or report exact
  recovery state;
- directory collection or collection identity becomes necessary;
- mutation would exceed 128 assets or 32 MiB; or
- completion would require a dependency, version, limit, or release-policy
  change.

## Completion report

Return a bounded candidate summary with the implemented migration,
normalization, provenance, and reconciliation contracts; Terminal Nova exact
SVG equality results for absent/partial/complete provenance; focused and full
test counts; audit/visual/package evidence; digest bases and vectors;
transaction/rollback evidence; unchanged analyzer and schema-1 evidence; and
all intentional deferrals. Do not claim directory collection, higher limits,
unsafe normalization, or release readiness.
