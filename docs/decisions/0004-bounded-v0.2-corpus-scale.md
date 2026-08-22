# ADR 0004: Bounded v0.2 Corpus Scale and Deferred Nested-Corpus Support

- Status: Accepted
- Date: 2026-08-22
- Scope: lifecycle scale, nested identity, audit/product boundary, bundle and
  preview scale, and machine-output cardinality
- Controlling evidence:
  [v0.2 dogfood corpus audit](../evaluations/v0.2-dogfood-corpus-audit.md)
- Amends: [ADR 0002](0002-safe-reconciliation-and-provenance.md) and
  [ADR 0003](0003-deterministic-bundles-and-machine-results.md)

## Context

Four pinned external trees contain 2,256, 3,453, 6,410, and 12,457 SVG files.
None passes schema 1 unchanged. Tabler has 1,054 basename/asset-ID collision
groups affecting 2,109 files; theSVG has 17 repeated-leaf groups affecting
12,444 files. The largest tree remains under 32 MiB of SVG source, but file
count, identity, profile, preview, and complete-plan costs are independent.

The evidence must not turn v0.2 lifecycle work into schema 2, an unbounded
archive processor, or a premature nested-collection interface.

## Alternatives

### Scale

- **Retain fixed limits and support curated shards (selected).** This preserves
  the existing transaction and resource boundary and matches the supported
  Terminal Nova release contract.
- Raise or operator-configure limits. Rejected for v0.2 because the corpora do
  not pass schema 1 and therefore cannot validate lifecycle behavior at the
  higher bound.
- Batch canonical mutation. Rejected because a later validation failure could
  expose a partial next canonical tree unless the batches merely populate one
  still-unpublished complete stage.

### Identity

- **Retain basename identity plus manifest-assisted round-trip (selected).** A
  collision-free curated shard remains deterministic and v0.1-compatible.
- Path-derived IDs, strip prefixes, collection prefixes, or mapping files.
  Plausible, but deferred as one coherent v0.3 decision because each changes
  rename ergonomics and long-lived human IDs.
- Opaque hashes. Rejected as ordinary IDs because they are not maintainable.

### Compatibility analysis

- Add `tfsb analyze` in v0.2. Rejected because directory/ZIP authority,
  detailed output, scale ceilings, and profile diagnostics are inseparable from
  the v0.3 profile decision.
- **Retain a checked, non-package audit helper (selected).** It preserves the
  evidence without creating a public command or compatibility promise.

### Bundle and preview

- **Keep bounded in-memory store-only ZIP and one static page (selected).** A
  128-entry/32-MiB proxy completed with about 112 MiB maximum resident size.
  Preview remains bounded to 128 assets and adds native lazy image hints.
- Streaming ZIP or chunked/scripted preview. Deferred because the supported
  v0.2 boundary does not require either.

## Decision

1. Full-corpus import, reconcile, bundle, and preview are not v0.2 goals.
2. Archive limits remain 1,024 total entries, 128 selected SVGs, 8 MiB per
   selected entry, and 32 MiB aggregate selected content. A fixed, non-
   configurable 128 MiB raw archive-file ceiling bounds whole-archive
   provenance hashing: 64 MiB central-directory allowance plus 32 MiB selected
   aggregate leaves 32 MiB for local headers, metadata, and other bounded ZIP
   structure. Raw size is rejected before a full scan; EOCD and central-
   directory structure validate before bounded chunked SHA-256 hashing.
3. A canonical mutation command refuses a complete next project above 128 SVG
   assets before staging. Read-only behavior above that boundary must be
   explicitly documented per command and cannot be used to claim lifecycle
   support. `list` returns the complete inventory, `check` returns complete
   canonical/build/install inspection, `fmt --check` reports the complete set
   of format paths without writing, and `diff --provenance` returns the
   complete provenance relationship. Applying `fmt`, default `build`,
   `install`, and `preview` reject 129 or more assets before lock or stage
   creation. Bundle remains limited to an explicit subset of at most 128.
4. Complete planning, one sibling staging tree, snapshot revalidation, one
   lock, and one swap remain the mutation model. Batching may populate only the
   unpublished stage and may never publish a partial canonical tree.
5. Unmanifested import/reconcile retains basename-derived IDs. TFSB's verified
   bundle manifest may supply an explicit asset ID. A third-party candidate
   may use exact selectors to form one collision-free subset, but selected
   entries with duplicate derived IDs fail before planning.
6. `tfsb analyze`, path-derived identity, mapping files, collection prefixes,
   configurable higher limits, streaming ZIP, chunked preview, NDJSON, and
   schema-profile expansion are deferred.
7. Bundle retains `fflate@0.8.3` in-memory method-0 construction and existing
   limits. Preview retains one inert page, no script, and at most 128 assets;
   generated images use `loading="lazy"` and `decoding="async"`.
8. Machine JSON for a valid read-only project result is complete and
   untruncated, including above 128 hand-authored assets. Human output may
   summarize only with exact total/omitted counts and a route to selectors or
   JSON. Mutation/bundle/preview limit failures return aggregate diagnostics;
   no partial machine record stream is authoritative.
9. Terminal Nova remains the v0.2 release fixture. External trees are local
   dogfood and v0.3 evidence unless a separately reviewed transformed shard is
   both schema-compatible and legally suitable.

## Consequences

The v0.2 implementation remains small, transactionally reviewable, and
backward-compatible. It does not claim that source byte size alone proves
memory safety: a 2.8 MiB generated Tabler SVG caused about 152 MiB maximum
resident size in a direct current-parser probe. Sequential parsing and the
fixed project boundary remain mandatory, and implementation stress evidence
must include the largest supported shapes.

Operators must curate and legally review shards outside TFSB. Nested identity
ergonomics and broad profile compatibility remain unresolved rather than being
embedded as accidental v0.2 API.

## Rollback

If the fixed boundary proves insufficient before release, do not silently
increase it. Return to an architecture phase with a compatible corpus and
measured complete-plan, staging, ZIP, preview, and output evidence. Existing
v0.1 behavior, this ADR, and the audit evidence remain historical records.
