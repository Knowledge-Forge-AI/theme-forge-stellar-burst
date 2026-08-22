# TFSB23 semantic diff, canonical formatting, and machine results

## Implemented surface

TFSB23 adds the third bounded v0.2 lifecycle slice without changing the public package version or adding a runtime dependency.

1. `src/receipt.ts` implements closed v2/v3 receipt types, strict discriminated parsing (`absent`, `invalid`, `v2`, or `v3`), deterministic v3 serialization, and normalized project-policy evidence. Valid v2 receipts remain operational ownership evidence; every successful new build writes v3.
2. `src/diff.ts` implements read-only provenance, archive, build, and install baselines as one closed `DiffResult` union. Archive changes are typed and deterministically ordered. Path geometry uses lowercase raw SHA-256 under `tfsb-path-text-v1`, Unicode-scalar lengths, and prefix/suffix previews bounded to 64 scalars.
3. `src/fmt.ts` implements opaque, runtime-authenticated format plans and complete canonical-tree transactions. Only project and asset TOML bytes are rewritten. Reparse/model equality is required before execution; companion and provenance bytes are carried unchanged.
4. `src/json.ts` and `src/cli.ts` implement schema-version-1 envelopes for `check`, `list`, `reconcile`, `diff`, `bundle`, and `fmt`. Expected JSON-mode outcomes use stdout only, errors use `data: null`, diagnostics are deliberately mapped, and exit status matches the envelope.
5. `src/list.ts` now includes every canonical companion, using an empty destination list where no declaration exists. Human record displays use a deterministic threshold of 50 and report exact totals and omitted counts; JSON is complete.

The public package root exports the receipt codecs and types, path digest, four diff operations and union, opaque formatter operations and DTOs, and JSON envelope/presentation contracts. CLI parse shapes, transaction authority, filesystem snapshots, private ZIP bytes, and exceptions remain private.

## Baseline semantics and limitations

- Provenance diff treats accepted divergence and accepted absence as archive-checkpoint differences (exit `2`) while reconciliation continues to treat them as accepted, non-conflicting state.
- Archive diff preserves manifest IDs; ordinary archives use tracked provenance entry names and basename identity only for new entries. It does not infer renames or artistic meaning.
- Build diff requires v3 evidence discoverable at the currently configured build path. Missing, invalid, and v2 receipts are baseline-unavailable; TFSB does not search the repository for historical build directories.
- Formatting intentionally removes comments. A byte-changing format after a build leaves raw canonical source hashes stale until a separate build.
- Preview JSON, preview integration hardening, and the final lifecycle workflow remain TFSB24 work.

## Verification ownership

Focused TFSB23 tests cover strict deterministic receipts and v2 compatibility, all four clean baselines, frozen path-digest vectors, format plan authenticity and semantic/provenance invariants, post-format build drift, and deterministic JSON envelope/exit behavior. Repository-wide closeout verification remains dispatcher-owned.
