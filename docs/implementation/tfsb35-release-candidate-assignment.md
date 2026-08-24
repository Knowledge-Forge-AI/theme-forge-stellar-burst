# TFSB35 release-candidate assignment

## Executor and objective

This bounded assignment is suitable for Gemini 3.7 Flash Medium. Prepare the
already-qualified v0.3 implementation as an exact local release candidate.
Do not add, redesign, or substantially repair product behavior.

## Starting gate

Require a clean checkout at the accepted TFSB34 result, package version
`0.2.0`, unchanged dependency manifests, and readable v0.3 release-acceptance
artifacts. Run the repository's typecheck, Vitest, production audit, Playwright,
pack dry-run, and diff-check gates before editing. Stop on material drift.

## Authorized work

1. Bump the package version from `0.2.0` to `0.3.0` in package metadata and the
   lockfile's root package record only.
2. Update the changelog, unreleased release notes, and package metadata from
   verified TFSB34 behavior. Do not invent support or compatibility claims.
3. Qualify a clean-checkout install, build, typecheck, Vitest, Playwright,
   production audit, and package dry run.
4. Create the exact local npm tarball with `npm pack`, then record its filename,
   byte count, SHA-256, SHA-512 SRI, and complete inventory.
5. Install the tarball into a registry-independent temporary consumer and run
   analyze, direct schema-2 import, exact-common import, migrate check/apply,
   build, install, check, list, diff, bundle, manifest re-import, and preview.
6. Verify generated declarations and package exports from the installed
   tarball, not from the source checkout.
7. Prepare public-composition projection material and an exact checklist of
   GitHub and npm publication prerequisites for a later publication phase.

## Prohibited work

- No schema, SVG profile, analyzer, normalizer, migration, reconcile, bundle,
  preview, transaction, or public API feature changes.
- No dependency additions or upgrades.
- No higher limits, directory mutation, collection identity, Studio/GUI work,
  or v0.4 work.
- No npm publication, GitHub release, tag, public projection, or remote write.
- No repair of a substantial product defect discovered during release prep.

## Mandatory stop conditions

Stop and return the smallest reproducible defect report if any product test,
local tarball consumer lifecycle, declaration/export check, security boundary,
package inventory, dependency audit, or deterministic artifact check fails.
Return the defect to dispatcher-owned engineering work; do not broaden TFSB35.

Stop if the version bump changes more than the expected package metadata, if a
dependency or lock resolution changes, if the tarball contains tests, tools,
evaluation records, dogfood metadata, scratch data, or credentials, or if any
publication step would require authority not present in the later workflow.

## Required evidence and handoff

Report the resulting local commit/tree only if the dispatcher separately owns
and authorizes Git publication. Otherwise report the unstaged candidate diff.
Include final test counts, browser counts, audit result, exact tarball inventory
count, byte count, SHA-256, SRI, installed-consumer lifecycle results, export and
declaration checks, and the publication-prerequisite checklist. Explicitly
defer publication to TFSB36A/B or equivalent authorization.

