# ADR 0006: Productized Analyze and Explicit Normalization

- Status: Proposed for v0.3 implementation
- Date: 2026-08-22
- Scope: read-only compatibility analysis, diagnostic taxonomy, limits, and
  import normalization authority
- Controlling architecture: [v0.3](../architecture/v0.3.md)
- Authoritative evidence:
  [v0.3 analyzer dogfood baseline](../evaluations/v0.3-analyzer-dogfood-baseline.md)
- Historical evidence:
  [v0.3 compatibility projection](../evaluations/v0.3-compatibility-projection.md)

## Context

The v0.2 audit proved that a first parser failure is not a compatibility
inventory. It also showed that the four measured trees exceed the 128-asset
mutation boundary while remaining practical read-only inputs. v0.3 needs a
repeatable product oracle without turning analysis into import or repair.

## Decision

1. v0.3 adds:

   ```text
   tfsb analyze <directory-or-archive> [--json] [--details <output.ndjson>]
   ```

2. A directory means current filesystem bytes, even inside a Git worktree.
   `analyze` never infers tracked HEAD. Operators who require tracked evidence
   create a Git archive themselves. ZIP input is one immutable opened-file
   snapshot and reuses the safe ZIP structural decoder under analysis limits.
3. The command never follows symlinks, uses the network, repairs source, writes
   canonical state, or invokes Git. It detects input changes by pre/post file
   identity and directory-inventory checks and invalidates the whole result.
4. Independent inventory runs before profile classification. Unsafe content is
   recorded even when an earlier unsupported construct exists.
5. Every file has one result for each closed profile key. `schema1` names
   `tfsb-svg-schema-1` and classifies `directly_importable`, `unsupported`, or
   `unsafe`; it never normalizes. `commonV03` names
   `tfsb-svg-common-v0.3` and classifies `directly_importable`,
   `importable_with_normalization`, `unsupported`, or `unsafe`. Each aggregate
   contains separate per-profile counts. Adding a future profile requires an
   analyzer schema revision; it cannot redefine one unqualified
   `classification` field.
6. Human output names both profiles and contains their aggregates plus at most
   20 deterministic relative-path samples per public diagnostic. `--json`
   emits one v1 envelope whose complete data has `scanCompleted: true`, input
   kind/totals, `profiles.schema1`, `profiles.commonV03`, resource observations,
   identity results, and samples keyed by profile. `featureCounts` is populated
   for both profiles from the profile-independent inventory pass. Top-level envelope
   diagnostics contain at most 20 deterministic representative `MachineDiagnostic`
   records per public code, deduplicated across profiles and strictly conformant
   with single-location mapping. `analyze` is added to `JsonCommand`; `JsonStatus`,
   `JsonExitCode`, and `MachineDiagnostic.severity = "error"` remain frozen.
7. Status/exit uses only the target `commonV03` result. A complete all-direct
   scan is `ok`/0 with complete data. A complete scan with normalization or
   unsupported and no unsafe is `drift`/2 with complete data. A complete scan
   with unsafe is `error`/1 with complete data. Any failure preventing a
   complete authoritative scan is `error`/1 with `data: null`. Data presence is
   the primary discriminant; complete data also says `scanCompleted: true`.
8. `--details` writes closed `tfsb-analyze-details` v1 NDJSON in relative-path
   order. Its header names both profile keys/identifiers, every file record has
   both profile results, and its footer has per-profile counts plus SHA-256 of
   preceding canonical JSON lines including LF. Partial NDJSON is never
   published.
9. Relative details targets resolve under the invocation working directory and
   cannot escape it. Explicit absolute targets are permitted after no-follow
   validation of every existing parent component. Parent must exist; target
   must be absent/non-symlink and disjoint from analyzed input. Project
   protected-tree policy applies only when a TFSB project is discoverable from
   the invocation working directory. Analyzing `.` therefore remains usable
   through an absolute sibling target. A mode-0600 exclusive sibling temp is
   written/fsynced, input/parent/absence snapshots are revalidated, and atomic
   same-filesystem hard-link publication provides no-overwrite semantics;
   parent fsync and exact owned-temp cleanup follow. No overwrite fallback is
   permitted.
10. Reports contain paths, counts, feature codes, typed model locations, and
   classifications. They contain no source text, title/description values,
   path data, arbitrary attribute values, absolute input path, stack, host,
   username, or environment data.
11. Analysis limits are fixed: 100,000 candidate entries, 50,000 SVG files,
   8 MiB per SVG, 512 MiB aggregate SVG bytes, 512 MiB raw ZIP bytes, 1 GiB
   declared archive bytes, 100:1 compression ratio, 250,000 XML elements per
    file, and 2,000,000 XML elements per analysis. Per-file byte/element and
    target-profile 1,024-modeled-element/eight-level-depth breaches are
    `unsupported` only if bounded streaming inventory reaches EOF and remains
    authoritative. Candidate/SVG/aggregate-byte/analysis-element and archive
    resource breaches prevent completion and return `data: null`. ZIP64,
    encrypted entries, unsupported compression, duplicate/ambiguous names,
    non-regular entries, and traversal fail closed.
12. The exact public code and result mapping is the closed
    [analyze contract](../evaluations/v0.3-analyze-contract.json), including
    invalid root/artwork/path/reference/shape-rendering, UTF-8, per-file and
    scan-wide limits, archive/input, snapshot, and details-output cases.
    Internal `SVG_*`, `XML_*`, exception, and parser strings never escape.
    Complete per-code counts live in profile data; envelope diagnostics are
    bounded representatives. The closed normalization IDs also live in typed
    data. The proposed `ANALYZE_NORMALIZATION_*` diagnostic family is retired.
13. TFSB30 counts are provisional projection bounds because its non-product
    helper deliberately omits complete parser/profile constraints. TFSB31
    produces authoritative counts. Any discrepancy stops completion and
    returns architecture and projection artifacts for reviewed correction;
    exact old counts are not implementation acceptance gates. TFSB31R1 records
    the reviewed disposition without rewriting the historical projection JSON:
    its predeclared authority block and linked report now point to the separate
    authoritative product baseline.
14. Import adds `--normalize exact-common`,
    `--normalization-map <normalization.toml>`, and `--dry-run`.
    `exact-common` authorizes only named semantics-preserving transformations:
    title-only labelled ownership with generated IDs, root-presentation
    promotion, SVG namespace/version canonicalization, definition-order
    canonicalization (placing `<defs>` before artwork in canonical output),
    local xlink conversion to SVG 2 href, explicit SVG numeric defaults, equal
    rect-corner completion, and primitive preservation. It never chooses
    decorative versus consumer-labelled.
15. A closed normalization map may declare one explicit default for unlabeled
    files and per-entry overrides. Every affected entry is still listed in the
    dry-run plan. The map cannot change collection identity, introduce raw XML,
    accept unsupported syntax, or override an unsafe diagnostic.
16. The normalization report records source classification, every exact or
    intentional normalization, every rejection, resulting asset identity,
    accessibility authority, and `exact_semantic` versus
    `intentional_semantic` disposition. There is no “make it work” policy.

## Consequences

Analysis can cover complete measured corpora without raising lifecycle limits.
Import remains bounded to 128 selected assets and remains archive-based in
v0.3. A favorable profile result does not resolve basename collisions,
licensing, trademark rights, or redistribution authority.

Source acceptance is not profile classification. A directory scan still fails
closed on any traversed symlink. When a tracked repository export contains a
symlink, regular-SVG tracked-blob evidence may measure the profile only if it is
explicitly identified as a measurement projection; it is not a successful
analysis of the original tree and grants no ignore-symlinks behavior.

## Rollback

The analyzer is additive and read-only except for an explicitly named details
output. If its contract cannot be met, omit the product command and retain the
non-package audit helper; do not weaken input safety or expose parser text.
