# TFSB21 dispatcher assignment: provenance and bounded reconciliation core

## Objective

Implement the accepted v0.2 provenance and reconciliation core from
[v0.2.md](../architecture/v0.2.md),
[ADR 0002](../decisions/0002-safe-reconciliation-and-provenance.md), and
[ADR 0004](../decisions/0004-bounded-v0.2-corpus-scale.md). Preserve every v0.1
command and schema-1 fixture contract.

## Authority and boundaries

This phase may add provenance codecs, digest and classification cores,
reconciliation planning, the canonical-tree transaction engine, public
plan/result APIs, CLI reconciliation flags, and focused tests and fixtures.

Do not implement deterministic bundle output, bundle-manifest import, semantic
diff presentation, formatter, JSON command mode, preview, `tfsb analyze`,
path-derived identity, strip-prefix or mapping-file identity, configurable
limit increases, schema/profile expansion, version bump, release composition,
publication, or dogfood asset copying.

No external dogfood repository may be modified. External corpus summary data
is architecture evidence, not a TFSB21 fixture source.

## Required contracts

### Provenance

- Add closed `tfsb-import-provenance` schema version 1 at
  `.tfsb/provenance.json` with deterministic field order, record order,
  two-space JSON, UTF-8, and final LF.
- Implement `tfsb-asset-toml-v1` semantic digests using the frozen canonical
  asset serializer, plus exact companion byte digests.
- Reject unknown fields/versions/bases, malformed digests, duplicates,
  impossible paths, and ID/path disagreement before classification.
- Never store an absolute archive path, host/user/environment value, or copied
  archive.

### Classification and authority

- Implement the complete paired-checkpoint vocabulary for aligned,
  archive-changed, canonical-edited, conflict, new, omission, canonical-missing,
  untracked-match, untracked-conflict, companion, accepted-divergence, rename,
  and removal states defined by ADR 0002.
- `reconcile` is read-only unless `--apply` is present; `--dry-run` is an alias
  for the default and conflicts with `--apply`.
- One unresolved record blocks the entire apply.
- `--resolve key=canonical|archive`, `--rename`, `--rename-companion`,
  `--remove`, and `--remove-companion` provide exact per-record authority.
- Omission never deletes. Rename is never inferred from a path or equal bytes.
- A canonical resolution records stable accepted divergence and never becomes
  future archive-overwrite authority.

### Candidate and identity

- Inspect and validate the complete ZIP name/type/security domain before
  selection. Repeated selectors are exact after existing portable-name
  normalization; asset-ID collision checks apply to the selected candidate
  set.
- Preserve basename-derived identity for unmanifested input. Do not add any
  path-derived or hash-derived ordinary ID.
- Retain the existing 1,024-entry, 128-selected-SVG, 8-MiB-per-entry, and
  32-MiB aggregate archive limits.
- Refuse a planned next canonical project above 128 assets with a stable
  resource diagnostic before staging or mutation.

### Transaction

- Discover and validate current state, candidate, and provenance; classify all
  records; render and reparse the complete next allowlisted `.tfsb` tree; then
  and only then acquire/commit through the canonical transaction shell.
- Use `.tfsb.lock` as a no-follow project-root sibling, snapshot identities and
  bytes, owner-only same-parent stage/backup trees, supported fsyncs, precommit
  confinement and snapshot revalidation, one directory swap, handled rollback,
  and explicit orphan recovery diagnostics.
- A provenance-only bootstrap uses the same transaction while preserving
  semantic TOML and companion bytes exactly.
- A failure at any injected point leaves the old complete canonical tree or
  explicit recoverable residue. No batch may publish a partial next tree.

### Public and CLI surface

- Add reusable typed classifier and planner seams rather than embedding policy
  only in CLI presentation.
- Implement the command shape and human output/exit behavior in v0.2.md.
- Do not add v1 JSON output in this phase; TFSB23 owns that presenter.
- Exit 0 is clean/applied success, 1 is invalid/failed operation, and 2 is a
  valid drift/conflict state.

## Required scenarios

Use the Terminal Nova production SVGs and README companion to cover the full
reconciliation matrix (architecture scenarios 1–8, 16, and 17 from v0.2.md /
ADR 0002; scenarios 9–15 belong to subsequent deferred phases), including
matching bootstrap, one-sided changes, two-sided conflict, accepted canonical
divergence, adds, omission, explicit rename, companion replacement, removals,
canonical missing, partially populated provenance, collisions, and failure
injection. Add focused cases for:

- 128 assets succeeds and 129 assets refuses before staging;
- two selected duplicate basenames fail before planning, while an exact
  selector may choose one collision-free subset; portable-name collisions fail
  archive validation;
- NFC/case portable collision fails deterministically;
- a tracked icon moving directories is new plus omission until exact rename;
- a human-edited subset reconciles against a bounded collision-free shard;
- malformed or stale provenance cannot suppress current validation;
- lock contention, changed snapshot, stage failure, swap failure, rollback
  failure, cleanup failure, and orphan recovery;
- no dogfood asset or legal document enters source or fixtures.

## Verification

Run focused classifier, codec, archive-mapping, transaction, CLI, and regression
tests while iterating. From the integrated result run:

```text
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Also validate every new JSON fixture strictly, check deterministic provenance
bytes across two runs, prove package contents remain allowlisted, and inspect
staged and unstaged diffs. Do not run Playwright unless the phase changes a
rendered visual contract, which this assignment does not authorize.

## Acceptance and stop conditions

TFSB21 is complete only when the full bounded reconciliation matrix passes,
v0.1 compatibility remains green, every mutation shares one recoverable tree
transaction, resource/collision failures precede staging, and no deferred
surface has begun.

Stop rather than improvise if the 128-asset complete plan cannot be kept
transactional, a required recovery state cannot be made unambiguous, profile
expansion becomes necessary, or a safe behavior would require changing the
accepted identity or provenance contract.
