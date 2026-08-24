# ADR 0007: Schema Migration and Provenance Compatibility

- Status: Proposed for v0.3 implementation
- Date: 2026-08-22
- Scope: schema-1 migration, digest bases, provenance checkpoints, diff, and
  transaction semantics
- Controlling architecture: [v0.3](../architecture/v0.3.md)

## Context

Schema 1 is released and its canonical TOML digest is active provenance
authority. Schema 2 necessarily serializes different TOML even when it emits
the same SVG. Treating those bytes as one digest basis would turn migration
into false convergence or lose the archive/canonical relationship.

## Alternatives

- Silently read and rewrite schema 1 as schema 2. Rejected because ordinary
  commands would gain migration authority.
- Replace v1 checkpoints with v2 digests. Rejected because it destroys the
  evidence needed to reconcile an older archive.
- Require the original archive for migration. Rejected because canonical
  schema-1 state is sufficient and the archive may no longer exist.
- **Use a whole-project transaction and explicit cross-basis checkpoint
  (selected).**

## Decision

1. v0.3 adds `tfsb migrate --check [--json]` and
   `tfsb migrate [--json]`. Migration is schema-1 to schema-2 and project-wide;
   selected or mixed migration is unsupported.
2. `--check` parses the complete project, constructs the complete v2 tree,
   serializes every before/after SVG, and reports the plan without writing.
   Exit 0 means already schema 2; exit 2 means a valid migration is available;
   exit 1 means migration is invalid or unsafe.
3. Migration maps schema-1 accessibility to `labelled`, preserves title,
   description, explicit IDs, focusability, metadata, definitions, paths,
   groups, uses, transforms, presentation, project policy, and asset identity.
4. Every migrated asset must emit SVG bytes exactly equal to its fresh
   schema-1 serialization. Visual similarity alone is insufficient. Any byte
   difference stops the whole transaction.
5. Schema-1 raw comments and formatting are not preserved. Canonical v2 TOML is
   the accepted divergence. Companion bytes are preserved exactly. Build,
   install, preview, and bundle outputs are not rewritten by migration.
6. `tfsb-asset-toml-v1` stays frozen. Schema 2 introduces the independently
   frozen `tfsb-asset-toml-v2`, defined as SHA-256 over canonical schema-2 asset
   TOML UTF-8 bytes including the final LF. `tfsb-svg-output-v1` is SHA-256 over
   canonical SVG bytes and supplies cross-schema equivalence evidence; it is
   not a replacement for either TOML basis.
7. Provenance schema 2 represents archive evidence as optional. A migrated
   asset has `archive: null` or an exact existing archive checkpoint with its
   source/canonical bases and digests, plus an independent mandatory migration
   record containing v1 canonical basis/digest, v2 canonical basis/digest,
   before/after `tfsb-svg-output-v1` digests, `svgEquivalent: true`, and
   `schema_migration_accepted_divergence`. It never claims that v1 and v2 TOML
   bytes match or that absent archive evidence exists.
8. Migration succeeds from all truthful provenance states:
   - no provenance creates only migration canonical/SVG transition evidence
     and retains `archive: null`;
   - valid partial provenance preserves each tracked archive checkpoint exactly
     while untracked assets retain `archive: null`; and
   - complete provenance preserves every archive/canonical relationship and
     adds the independent transition.
   Every migrated canonical asset therefore records v1-to-v2 equivalence
   without manufacturing archive history.
9. Reconciliation with an older unchanged archive compares it against a
   preserved v1 archive checkpoint and retains the accepted migrated canonical
   divergence. An asset with `archive: null` has no historical archive match.
   A changed/new archive is parsed and normalized under current explicit
   policy; existing conflict and resolution authority still applies.
   Provenance never bypasses current archive validation.
10. Semantic diff maps a schema-1 asset to the equivalent `labelled` common
   model. Equivalent v1/v2 accessibility and artwork compare equal. Schema
   version, migration checkpoint, and canonical TOML basis are reported as
   provenance facts, not artwork changes. New v2 modes, presentation, geometry,
   and transforms have typed model locations.
11. Migration uses the existing root-confined lock, complete sibling stage,
    staged reparse, before/after snapshot revalidation, backup, one promotion,
    rollback, and recovery-residue protocol. A crash cannot publish a mixed
    schema tree.
12. Because canonical TOML bytes change, existing build receipts become
    source-stale even though SVG output bytes remain equal. Existing generated
    and installed files remain untouched. A later explicit build refreshes the
    receipt; install is never implied.
13. Bundle manifest and JSON result versions are independent of project schema.
    Asset SVG entries remain equal across this migration, but a v0.3 bundle as
    a whole may differ from v0.2 because the manifest generator version is
    truthful. Repeated v0.3 bundles remain byte-deterministic.
14. `exact-common` policy identity is frozen at policy version 1, map schema
    version 1, target schema 2, and digest basis
    `tfsb-normalization-policy-v1`. The digest covers fixed-order policy ID,
    policy version, target schema, map schema, and SHA-256 of canonical parsed
    map bytes (or `none`). Canonical map serialization sorts normalized source
    entries by UTF-8 bytes and ignores source formatting/comments. Provenance
    stores identity/digests and implementation version, never a map path.
    Formatting-only map changes preserve the digest; semantic authority or a
    behavior-changing implementation requires a new digest/policy version.
15. If the original map is unavailable, canonical state remains valid but
    changed archive input cannot be reconciled. A supplied map must reproduce
    the stored canonical map and policy digests. Otherwise reconcile reports
    authority required and performs no mutation.
16. TFSB33 must cover no-provenance, mixed partial-provenance, and complete-
    provenance projects; unchanged and changed archive inputs for tracked and
    untracked assets; missing map, formatting-equivalent map, semantically
    changed map, and policy-implementation version changes. Each scenario must
    prove diff/reconcile does not invent convergence or archive history.
17. Ordinary import, build, install, check, list, reconcile, diff, fmt, bundle,
    and preview never migrate a project. `fmt` dispatches to the current schema
    writer only.

## Consequences

Terminal Nova can move to schema 2 without losing source, visual, or
provenance authority. The provenance format becomes more explicit, while the
released v1 record and digest remain readable.

## Rollback

Before promotion, migration leaves schema 1 untouched. After a successful
migration, rollback is version-control restoration of the complete pre-
migration `.tfsb` tree and any separately managed derived state; there is no
implicit down-migration command.
