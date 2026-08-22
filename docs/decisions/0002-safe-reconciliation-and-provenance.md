# ADR 0002: Paired-Checkpoint Provenance and Explicit Reconciliation Ownership

- Status: Accepted
- Date: 2026-08-22
- Scope: incremental archive reconciliation, provenance, conflict ownership,
  and canonical mutation
- Controlling contract: [v0.2 lifecycle architecture](../architecture/v0.2.md)

## Context

TFSB v0.1 intentionally refuses to import into an existing `.tfsb`. That gives
initialization a safe absent-to-present transaction, but it does not support a
normal designer revision cycle. The next archive cannot simply replace
canonical TOML: after import, canonical TOML is human-owned source and may
contain deliberate edits.

The lifecycle needs to distinguish changes to canonical state from changes to
the incoming archive, preserve project policy and companions, report omission
without deleting, and commit a complete next canonical state. Existing v0.1
projects have no imported baseline, so the design must also bootstrap without
inventing history.

## Decision drivers

- Human-maintained canonical state must never be overwritten silently.
- The archive must remain a candidate, not a retained second source of truth.
- Missing and partially populated provenance must be safe ordinary states.
- Explicitly keeping canonical content must not create a recurring false
  conflict or later become archive-overwrite authority.
- Review noise and schema-1 changes must remain minimal.
- Adds, replacements, companion changes, renames, omissions, removals, and
  collisions must be planned together.
- All canonical and provenance mutations need one recoverable transaction.
- No machine-local archive path may enter committed state.
- Complete planning must have an evidence-backed project cardinality bound.

## Command alternatives

### A. One reconciliation planner and explicit apply controls (selected)

`tfsb reconcile <archive>` inspects the complete candidate and current project.
`--apply` executes only safe actions and per-record choices. Repeated
`--resolve key=canonical|archive` options state conflict direction. Renames and
removals also require exact per-record flags.

This gives one collision domain, one classification vocabulary, one plan, and
one commit boundary. Default execution is read-only.

### B. Separate import-add, replace, and read-only reconciliation commands

Small commands make authority look obvious locally, but each still needs the
same archive inspection, provenance, collision, and whole-project validation.
Either the logic is duplicated or the commands become thin aliases over one
hidden reconciler. Sequential adds and replacements also encourage partially
applied archive decisions.

### C. Interactive merge session

An interactive session could prompt for each difference, but it adds transient
state, complicates automation and failure recovery, and makes the durable
authority harder to review. TFSB does not need to be a merge editor.

## Provenance representation alternatives

### A. Central `.tfsb/provenance.json` (selected)

One closed, deterministic JSON file stores a sorted array of asset and
companion records. It is separate from schema-1 source and can be swapped with
the complete canonical tree.

Benefits are low review noise, a single validation surface, straightforward
stale-record checks, and one atomicity boundary. A rename updates one record
instead of leaving sidecars behind.

### B. Per-asset and per-companion sidecars

Sidecars localize each record but nearly double the file inventory, make
ordinary reviews noisy, increase stale-file and rename failure modes, and do
not remove the need for a multi-file transaction.

### C. Fields embedded in project or asset TOML

Embedding appears readable but changes the closed schema-1 language, couples
machine evidence to artwork, and causes normal archive bookkeeping to rewrite
human source. It would either require schema 2 or weaken schema closure. It is
rejected for v0.2.

### D. No provenance; require an explicit winner every time

This avoids stored evidence, but cannot identify unchanged or one-sided
changes. It turns safe routine updates into repeated destructive choices and
cannot provide meaningful baseline diff.

## Decision

Select command alternative A and representation alternative A.

Reconciliation classification uses one coherent canonical observation: the
planner snapshots `.tfsb`, decodes project, asset, companion, and provenance
semantics from those captured bytes, then proves the live canonical tree is
still identity-equal before returning a read-only or executable plan. A change
during planning fails closed with `CANONICAL_CHANGED_DURING_PLAN`. Public plan
fields are frozen presentation only; execution first retrieves private
planner-owned state, and private blockers and change state are the sole apply
authority. Copied, forged, or deserialized plans are invalid.

Provenance records paired checkpoints for each asset:

- a versioned semantic digest of the canonical model accepted at the previous
  reconciliation decision, or an explicit accepted-absence marker;
- a versioned semantic digest of the archive model accepted at that decision;
- whether the decision left them `aligned` or explicitly preserved
  `canonical` divergence;
- current asset ID and project-relative canonical path;
- normalized archive entry name, whole-archive SHA-256, selected raw-entry
  SHA-256, and tool version.

Companion records use the same pairing with exact byte digests. The original
archive path and original archive are not retained.

The semantic digest basis is `tfsb-asset-toml-v1`: SHA-256 over the exact UTF-8
bytes, including final LF, produced by a frozen version-1 canonical
asset-TOML serializer from the validated normalized model. This is independent
of input TOML layout. A raw canonical file digest is not stored because it does
not participate in conflict classification and would make formatting noisy.

## Conflict ownership

There is no `--allow-conflict`. A conflict has no default winner.

- `--resolve <key>=archive` authorizes archive replacement for that record and
  records aligned checkpoints.
- `--resolve <key>=canonical` preserves current canonical content, records the
  candidate as the archive checkpoint, records canonical ownership, and advances
  `canonicalModelDigest` to the current canonical model. This provides the
  documented exit to accept human edits from `CANONICAL_EDITED`, as well as
  resolving `CONFLICT` or accepting human changes on an archive omission.
- Candidate scope vs selection: by default, `reconcile` evaluates matching candidate
  entries for all currently tracked assets and companions in `.tfsb`. An entry is
  an omission only when the archive lacks that item. Explicit selection filters
  (`--select` / `--companion`) un-scope non-selected tracked records (preserving
  them untouched in canonical state without classifying them as omissions). Selection
  identifies candidate inputs; it never implies ownership or deletion.
- One unresolved conflict blocks the complete apply transaction.

Paired checkpoints prevent the canonical choice from becoming unstable. If
neither side changes after a canonical resolution, the accepted divergence is
clean reconciliation state. If the archive later changes while canonical
ownership remains, the result is a new conflict rather than an automatic
overwrite. Accepted canonical absence is retained as a tombstone while the
archive entry remains present, so the entry does not reappear as falsely new.

## Bootstrap and missing evidence

No provenance record is not treated as proof that canonical is unchanged.

- Equal canonical and candidate models are an `UNTRACKED_MATCH`; `--apply` may
  record them as aligned without rewriting semantic TOML.
- Different models are an `UNTRACKED_CONFLICT`; no write occurs without an
  explicit per-record direction.
- New candidate assets may be added after full collision checks.
- Existing canonical assets absent from the archive remain omissions and are
  retained.

A partially populated manifest follows the same rules record by record.
`tfsb import --record-provenance` writes aligned records in the same initial
`.tfsb` transaction; import without that opt-in retains v0.1 behavior. Thus the
production Terminal Nova project can adopt v0.2 with a matching archive through
a provenance-only transaction, while a mismatched historical archive cannot
manufacture a baseline silently.

## Renames, omission, and deletion

An archive entry with a new derived identity is not assumed to be a rename. It
is reported as a new asset plus an omission. `--rename old-id=entry` is the
explicit continuity assertion and updates asset identity, canonical path,
install references, and provenance together while preserving destinations.
Collision with any distinct current or candidate record is not a conflict with
a selectable winner; it is a validation failure.

Unmanifested identity remains basename-derived in v0.2. Exact selectors can
form a collision-free selected set, but cannot make two variant paths with the
same derived ID coexist. Path-derived IDs, strip prefixes, collection prefixes,
and mapping files are deferred by ADR 0004.

Archive omission never deletes. An archive omission is reporting evidence only.
Exact `--remove` or `--remove-companion` authority is required for canonical
removal. Canonical and policy records are planned together, but existing
generated and installed bytes are not deleted by reconcile and remain visible as
derived drift.

## Validation, collation, and trust boundary

Provenance is closed and strictly decoded. Records are serialized with fixed
field order, assets sorted by `assetId` in ascending UTF-8 byte order (Unicode
code point order) followed by companions sorted by `canonicalPath` in ascending
UTF-8 byte order, two-space indentation, UTF-8 encoding, and one final LF.

Unsupported versions or digest bases, invalid hashes, unknown fields, duplicate
records, impossible paths, or ID/path disagreement for an existing target fail
before classification. Current canonical and candidate values are always
reparsed, validated, and rehashed. An otherwise valid record whose canonical
target is absent is classified as `CANONICAL_MISSING`: canonical resolution
accepts the removal and records an absent canonical checkpoint while archive
resolution restores the selected asset. The record is dropped only when both
accepted sides are absent. It is not silently treated as either malformed
provenance or an archive omission.

Provenance is not cryptographic authentication. An actor who can maliciously
rewrite repository files can also rewrite provenance. Git review and repository
access control remain the integrity boundary; TFSB guarantees fail-closed
structure and comparison, not tamper-proof local state.

## Transaction decision

Reconcile renders and reparses a complete next `.tfsb` tree before writing. It
uses an exclusive project-local mutation lock `.tfsb.lock` created directly in the
project root directory (sibling to `.tfsb/`), same-parent staging, snapshot
revalidation, directory swap, best-effort rollback, and explicit crash-residue
diagnostics. Project root discovery (`findProjectRoot`) detects `.tfsb-stage-*`
or `.tfsb-backup-*` orphan residue before upward traversal and reports
actionable recovery instructions (`TFSB_RECOVERY_REQUIRED`). A provenance-only
update uses the same boundary and preserves TOML and companion bytes exactly.

The provenance initialization path captures expected canonical absence
immediately after import root validation. A concurrently created `.tfsb` is
never adopted as the expected replaceable snapshot. Transaction revalidation
and the final pre-promotion existence check invalidate a later observed tree
before any import-owned rename; the portable directory-rename boundary does
not claim atomic no-replace exclusion for an empty directory created after the
final check.

Before staging, reconciliation refuses a complete next project above 128 SVG
assets and retains the existing archive entry/byte limits. This is a v0.2
mutation support boundary, not authority to process a larger project in
batches. Sequential parsing may reduce transient work, but no batch can become
visible before the complete bounded plan and next tree validate.

This is transactional under handled failures and crash-recoverable, not a false
claim that portable filesystems offer an indivisible populated-directory swap.
If the new tree is active but the parent fsync fails, diagnostics distinguish
replacement state with a retained backup from initialization state with no
prior backup. Backup cleanup and rollback failures remain separate recovery
states and name only safe project-relative residue.

## Consequences

### Benefits

- Routine one-sided archive changes can apply without risking human edits.
- v0.1 projects have a safe, evidence-based adoption path.
- Explicit canonical resolutions remain stable across later inspections.
- Omission and rename cannot become accidental deletion.
- Schema 1 and ordinary artwork reviews remain clean.
- The classifier and transaction planner are reusable public library seams.

### Costs

- Provenance is another committed file requiring validation and review.
- Digest-only provenance can identify semantic change but cannot reconstruct a
  typed historical model; typed diffs require a candidate archive or another
  complete model.
- A same-user malicious provenance edit is not cryptographically detectable.
- Power loss can leave explicit stage/backup recovery residue.
- Per-record conflict choices are more verbose than a dangerous global override.
- Full external icon corpora require curated collision-free shards; v0.2 does
  not provide nested-collection identity or full-corpus mutation.

## Rejected follow-on scope

This decision does not add schema migration, an interactive merge editor,
archive retention, authenticated signing, remote sources, general file merge,
SVG-profile expansion, `tfsb analyze`, path-derived identity, configurable
higher limits, or partial/batched canonical publication.
