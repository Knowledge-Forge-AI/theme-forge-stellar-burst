# TFSB31 — Productized Read-Only Analyze

## Objective

Implement `tfsb analyze` as the versioned compatibility oracle specified by
[v0.3 architecture](../architecture/v0.3.md) and
[ADR 0006](../decisions/0006-productized-analyze-and-normalization.md).

This phase owns read-only directory/ZIP inventory, explicit schema-1 and common-
v0.3 profile classification, deterministic human/JSON/detail output, resource and snapshot
safety, and full-corpus read-only qualification. It does not implement schema
2, import normalization, migration, collection identity, or any source/canonical
mutation.

## Authority and starting state

1. Work only in the dispatcher-selected TFSB development checkout.
2. Fetch refs/tags, require a clean worktree, and verify the live semantic base
   contains the accepted v0.2.0 lifecycle plus TFSB30 architecture artifacts.
   Recorded historical SHAs are evidence, not a replacement for live semantic
   checks.
3. Verify `package.json`, `package-lock.json`, source version reporting, and the
   frozen schema-1 behavior remain v0.2.0. Record Git-tag presence separately;
   do not require or create a tag that is absent from the accepted repository.
   If a v0.2.0 tag is present, it must resolve to the released version.
4. Run and record `npm ci`, `npm run typecheck`, `npm test`,
   `npm audit --omit=dev`, and `npm run test:visual` before editing.
5. Stop on material starting-state divergence. Do not rebase, reset, rewrite,
   migrate, or guess.

## Required command surface

```text
tfsb analyze <directory-or-archive>
  [--json]
  [--details <output.ndjson>]
```

Add `analyze` to typed diagnostic operation/domain and CLI command/result
unions without widening unrelated command contracts. Human rendering remains a
leaf over typed results. `--json` must use the public envelope and contain no
human stream on stderr for expected outcomes.

## Source ownership and snapshots

### Directory

- Interpret a directory as current filesystem bytes. Do not invoke Git or infer
  tracked HEAD.
- Walk sorted relative paths without following symlinks.
- Reject a symlink at any traversed candidate boundary; do not silently skip a
  selected SVG symlink.
- Open regular files without following links; validate identity and size before
  and after reading.
- Snapshot each visited directory inventory and rescan before accepting output.
- If any file/directory changes, return `ANALYZE_SOURCE_CHANGED`, exit 1, and
  publish no details file.

### ZIP

- Reuse the existing safe central-directory/name/CRC/compression reader through
  an analysis-specific option object; do not fork a second archive parser.
- Hold one opened-file snapshot and revalidate it after analysis.
- Reject ZIP64, encryption, multi-disk, unsupported compression, duplicate or
  portable-colliding names, traversal, absolute names, non-regular entries,
  symlink modes, and changed input.
- Do not extract entries to disk or materialize all decompressed SVG bytes at
  once.

No source mode may access the network, execute project tooling, repair source,
or write canonical/generated state.

## Independent inventory

Implement a bounded inventory pass that does not call the schema parser and
does not stop at the first unsupported feature. For every SVG, inventory:

- XML declaration/node classes, comments, CDATA, DOCTYPE/entity, processing
  instructions, syntax and UTF-8;
- element and attribute names, namespaces, root attributes, presentation
  fields, paint families, transforms, local/external references, and active
  signals;
- accessibility title/desc/root-attribute presence without retaining text;
- file/byte/element counts and identity collisions; and
- bounded project-relative samples.

Inventory values must be closed feature families. Never retain path data,
title/description text, metadata text, arbitrary attribute values, XML snippets,
absolute paths, exceptions, or environment state in a result.

After inventory, classify combined file features against exactly two profile
keys:

1. `schema1` / `tfsb-svg-schema-1`, frozen schema-1 current behavior; and
2. `commonV03` / `tfsb-svg-common-v0.3`, declarative capability metadata from
   TFSB30.

TFSB31 does not implement schema-2 parsing. The v0.3 classification is a
feature oracle whose later schema parser must satisfy.

## Classification and diagnostics

Each file has one classification per evaluated profile. Schema 1 is exactly
`directly_importable | unsupported | unsafe`; its normalization count is fixed
at zero. Common v0.3 is exactly `directly_importable |
importable_with_normalization | unsupported | unsafe`.

Unsafe dominates unsupported and is discovered independently. Normalization
may be reported only for a feature whose exact target is specified by TFSB30;
it may never remove an unsafe or unsupported feature.

Implement every exact entry in the machine-readable
[v0.3 analyze contract](../evaluations/v0.3-analyze-contract.json). This
includes invalid root/missing artwork/path/reference/shape-rendering, UTF-8,
the distinct per-file/profile and scan-wide resource codes, archive/input,
source/snapshot, and details-output transaction failures. Table-driven tests
must prove every contract entry maps deterministically to diagnostic domain,
classification, data completeness vs scan abort, and safe sanitized message.
Status and exit code are evaluated at scan scope using `commonV03` with unsafe
dominance. Diagnostic objects strictly conform to `MachineDiagnostic` via
`mapMachineDiagnostic` without dual path/modelLocation fields. Representative
top-level envelope diagnostics are deduplicated by `(code, domain, location, message)`
across profiles up to 20 instances per code. Messages must be sanitized and must not
embed source values.

Normalizations use the contract's closed snake-case IDs in typed profile data.
Do not implement the superseded `ANALYZE_NORMALIZATION_*` family and do not
widen `MachineDiagnostic.severity` beyond `error`.

## Limits

Enforce before unbounded allocation:

| Limit | Value |
| --- | ---: |
| candidate entries | 100,000 |
| SVG files | 50,000 |
| one SVG | 8 MiB |
| aggregate SVG bytes | 512 MiB |
| raw ZIP | 512 MiB |
| declared ZIP bytes | 1 GiB |
| compression ratio | 100:1 |
| XML elements per SVG | 250,000 |
| XML elements per analysis | 2,000,000 |
| modeled elements per asset | 1,024 |
| group nesting depth | 8 levels |
| aggregate/human samples per diagnostic | 20 |

Process SVGs sequentially. Do not raise v0.2 import/mutation limits or use the
read-only limits in another command.

Per-file 8-MiB/250,000-element and target-profile 1,024-modeled-element/eight-
level-depth breaches classify that file `unsupported` only when a bounded
streaming inventory continues through EOF, still discovers later unsafe
signals, and completes the whole scan. If that authoritative inventory cannot
complete, return the scan-wide error form. Candidate/SVG count, aggregate byte,
2,000,000-analysis-element, and archive-wide resource breaches always prevent a
complete scan and return `data: null`.

## Output contracts

### Human and aggregate JSON

Human output names both `tfsb-svg-schema-1` and
`tfsb-svg-common-v0.3`, reports each profile's exact counts, leading stable
diagnostics, and at most 20 relative-path samples per code. It clearly states
that command status is based on common v0.3 and that compatibility is not
import, legal, trademark, or redistribution permission.

Implement these exact aggregate DTO boundaries (readonly details and concrete
observation subfields may be expanded only within the named objects):

```ts
type Schema1Classification =
  | "directly_importable"
  | "unsupported"
  | "unsafe";
type CommonV03Classification =
  | "directly_importable"
  | "importable_with_normalization"
  | "unsupported"
  | "unsafe";
type AnalyzeProfileKey = "schema1" | "commonV03";
type AnalyzeCode = /* exact codes in v0.3-analyze-contract.json */;
type AnalyzeNormalization = /* exact IDs in that contract */;

interface AnalyzeCounts {
  directlyImportable: number;
  importableWithNormalization: number;
  unsupported: number;
  unsafe: number;
}
interface AnalyzeProfileAggregate<P extends string> {
  profile: P;
  counts: AnalyzeCounts;
  diagnosticCounts: Partial<Record<AnalyzeCode, number>>;
  featureCounts: Readonly<Record<string, number>>;
  normalizationCounts: Partial<Record<AnalyzeNormalization, number>>;
}
interface AnalyzeJsonData {
  scanCompleted: true;
  input: { kind: "directory" | "archive" };
  totals: { files: number; svgFiles: number };
  profiles: {
    schema1: AnalyzeProfileAggregate<"tfsb-svg-schema-1">;
    commonV03: AnalyzeProfileAggregate<"tfsb-svg-common-v0.3">;
  };
  resourceObservations: Readonly<Record<string, number>>;
  identity: AnalyzeIdentitySummary;
  samples: Readonly<
    Record<AnalyzeProfileKey, Partial<Record<AnalyzeCode, readonly string[]>>>
  >;
}
type AnalyzeEnvelope = JsonResultEnvelope<"analyze", AnalyzeJsonData>;
```

`schema1.counts.importableWithNormalization` and
`schema1.normalizationCounts` are always zero/empty. Per-profile count sums
equal `totals.svgFiles`. Feature keys are inventory facts from the common
inventory pass; both profiles populate `featureCounts` from observed SVG
constructs. Feature keys are not diagnostic or normalization codes. JSON never
contains an absolute source path or per-file source content. Top-level
diagnostics contain at most 20 representative `MachineDiagnostic` objects per
code; the profile maps contain complete counts.

### Details NDJSON

`--details` is the command's only write. Implement these exact line DTOs:

```ts
interface AnalyzeDetailsHeader {
  recordType: "header";
  schema: "tfsb-analyze-details";
  schemaVersion: 1;
  inputKind: "directory" | "archive";
  profiles: {
    schema1: "tfsb-svg-schema-1";
    commonV03: "tfsb-svg-common-v0.3";
  };
}
interface AnalyzeDetailsProfile<P extends string, C> {
  profile: P;
  classification: C;
  diagnosticCodes: readonly AnalyzeCode[];
  featureCodes: readonly string[];
}
interface AnalyzeDetailsFile {
  recordType: "file";
  path: string;
  derivedAssetId: string | null;
  profiles: {
    schema1: AnalyzeDetailsProfile<
      "tfsb-svg-schema-1",
      Schema1Classification
    >;
    commonV03: AnalyzeDetailsProfile<
      "tfsb-svg-common-v0.3",
      CommonV03Classification
    > & {
      normalizations: readonly AnalyzeNormalization[];
    };
  };
  locations: readonly {
    profile: AnalyzeProfileKey;
    code: AnalyzeCode;
    modelLocation: string;
  }[];
}
interface AnalyzeDetailsFooter {
  recordType: "footer";
  records: number;
  profiles: {
    schema1: AnalyzeCounts;
    commonV03: AnalyzeCounts;
  };
  recordsSha256: `sha256:${string}`;
}
```

Emit one header, one file line per SVG in UTF-8 relative-path order, then one
footer. `recordsSha256` covers the exact UTF-8 bytes of the header and every
file canonical JSON line, each including its LF; it excludes the footer.

A relative target resolves beneath the invocation working directory and may
not escape. An explicitly absolute target is allowed after component-by-
component no-follow validation of an existing real-directory parent. Target
must be absent/non-symlink at planning and publication and disjoint from the
analyzed directory/archive. If project discovery from the invocation working
directory succeeds, reject `.tfsb`, configured build/install/companion
destinations, preview, and protected source/generated trees. With no project,
apply no invented project policy. Analyzing `.` must pass with an absolute
sibling target and fail for any target within `.`.

Capture parent identity and target absence; create an unpredictable sibling
temp with exclusive no-follow mode 0600; stream, fsync, and close; revalidate
the complete input snapshot, parent identity, and target absence; atomically
hard-link temp to target for no-overwrite publication; fsync parent; unlink
only the owned temp; fsync parent again. No check-then-overwrite rename or copy
fallback is allowed. Before publication, failure cleans only the exact temp.
After publication, cleanup failure reports exact residue without deleting the
complete target.

## Exit semantics

| Target `commonV03` result | Status | Exit | Data |
| --- | --- | ---: | --- |
| complete; all SVGs directly importable | `ok` | 0 | complete with `scanCompleted: true` |
| complete; normalization-required and/or unsupported, no unsafe | `drift` | 2 | complete with `scanCompleted: true` |
| complete; one or more unsafe | `error` | 1 | complete with `scanCompleted: true` |
| input/archive/scan-wide resource/snapshot/operation prevents completion | `error` | 1 | `null` |

The schema-1 profile never decides command status. When a safe scan completes
with unsafe files, emit the complete aggregate. When input integrity prevents a
complete scan, do not present partial counts as authoritative. Test envelope
status, exit, data presence, `scanCompleted`, and target-profile counts as one
invariant; status-union membership alone is insufficient.

## Required source and test scope

Expected production ownership includes a focused analyzer module, source
adapters, typed DTOs, presenters, CLI wiring, and narrow reuse changes to the
archive/resource layer. Keep inventory and profile classification separable.
Do not expose DOM/parser objects as public API.

Use repository-conventional flat tests such as:

- `test/analyze.test.ts` for inventory, classification, limits, deterministic
  aggregate results, and leakage rejection;
- `test/analyze-directory.test.ts` for symlinks, changed files/inventories,
  sorting, and read errors;
- `test/analyze-archive.test.ts` for ZIP safety reuse, ratio/count/size bounds,
  CRC, collisions, and changed archive; and
- `test/analyze-cli.test.ts` for human/JSON/NDJSON, exit parity, absent-output
  transactions, and stdout/stderr rules.

Use synthetic SVG/ZIP fixtures for every security and boundary case. Do not
copy dogfood SVGs or legal files into the repository.

At minimum cover:

1. one file containing an early unsupported attribute and later unsafe element
   to prove independent inventory;
2. title-only, unlabeled, decorative, conflicting labels/hidden state, and
   exact schema-1 accessibility;
3. root currentColor presentation plus every basic primitive;
4. translate/scale/rotate, matrix/skew rejection, local href/xlink, unresolved,
   cyclic, external, mixed/nested group, and symbol cases;
5. DOCTYPE/entity, PI, CDATA, script/style/image/foreignObject/animation,
   event/style attributes, external/data URL, and unknown namespaces;
6. every count/byte/node/sample boundary at limit and one over, including
   authoritative streaming completion after per-file/profile breaches and
   `data: null` for every scan-wide breach;
7. table-driven coverage of every public diagnostic and normalization entry in
   `v0.3-analyze-contract.json`, including envelope/data consistency and proof
   that no internal code leaks;
8. byte-identical aggregate and detail outputs across independent runs and
   reordered directory creation; and
9. assertion that reports contain none of a seeded secret title, description,
   path-data fragment, absolute root, stack, or environment marker.

Details-output transaction tests must additionally cover: relative target in a
non-project cwd; absolute target with no project; analyzing `.` to an absolute
sibling; relative escape; missing/symlink/non-directory parent; target symlink
and target race; target/input overlap for directory and archive; every
discovered protected tree; no project discovery from analyzed input alone;
source or parent snapshot change; exclusive temp collision; short write;
file-fsync, link-publication, parent-fsync, and cleanup failures; no overwrite;
no published partial bytes; exact owned-temp cleanup; and explicit residue
reporting after successful publication.

## Dogfood qualification

Dogfood is optional at unit-test runtime and mandatory for phase qualification
when the four matching local repositories are available.

1. Identify checkouts by remote, capture HEAD and dirty state, and export tracked
   HEAD through Git without changing the checkout.
2. Qualify full tracked exports as source-safety inputs. A traversed tracked
   symlink is an expected fail-closed source result, not an SVG compatibility
   classification. Qualify ZIP only when it can faithfully represent the
   complete accepted regular-file inventory without laundering a non-regular
   entry.
3. Produce authoritative `schema1` and `commonV03` counts from exact tracked
   regular SVG blobs. Treat that corpus as an evidence-only measurement
   projection when a full repository export is source-invalid. Treat TFSB30
   rows as provisional bounds, not pass/fail targets. On any discrepancy, stop
   phase completion, report exact rule/file/count deltas, and return the
   architecture and projection evidence for reviewed reconciliation. Do not
   edit implementation or counts merely to make old rows pass.
4. Repeat complete JSON/detail output independently and compare bytes.
5. Recheck dogfood status byte-for-byte against the before snapshot.

No dogfood result authorizes import, fixture copying, or redistribution.

The reviewed TFSB31R1 follow-up is the
[authoritative analyzer dogfood baseline](../evaluations/v0.3-analyzer-dogfood-baseline.md).
It records the Simple Icons tracked-symlink failure separately from its
regular-SVG profile counts and supersedes any reading of “complete export” as a
requirement to bypass the accepted no-follow contract.

## Non-goals and stop conditions

Do not implement or redesign:

- schema-2 TOML/SVG parsing or writing;
- accessibility emission, presentation cascade, geometry serialization, or
  migration;
- import `--normalize` or normalization maps;
- directory import/reconcile, collection mapping, path-derived IDs, prefixes,
  curated-shard commands, higher mutation limits, or chunked preview;
- Studio/GUI/service protocols; or
- source repair, network lookup, or license interpretation.

Stop if safe complete inventory requires arbitrary XML execution, if the ZIP
reader cannot be reused without weakening v0.2, if report privacy requires
source values, if full-corpus analysis exceeds the fixed bounds, or if
classification cannot keep unsafe distinct from unsupported.

## Verification and completion

Run at minimum:

```sh
npm run typecheck
npm test
npm audit --omit=dev
npm run test:visual
npm pack --dry-run --json
```

Also prove deterministic aggregate/detail output, unchanged dogfood worktrees,
no copied external content, unchanged 128-asset mutation limits, unchanged
schema-1 lifecycle behavior, intended package contents only, and no source
repair/network access.

TFSB31 is complete when `analyze` is a bounded, privacy-preserving,
inventory-first oracle over directory and ZIP snapshots; every taxonomy/exit
row has executable evidence; the four complete recorded corpora have
reproducible authoritative results with any provisional-count discrepancy
reviewed and recorded; and no schema-2 or mutation authority has leaked into
the phase.

Return a bounded candidate with exact test counts, projection counts/digest,
resource observations, dogfood before/after status, package contents, and all
deferrals. Publication and stage transitions remain dispatcher-owned.
