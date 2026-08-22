# ADR 0003: Store-Only Deterministic Bundles and Versioned Command Results

- Status: Accepted
- Date: 2026-08-22
- Scope: outbound bundles, portable manifests, JSON command results, and
  runtime-light preview boundaries
- Controlling contract: [v0.2 lifecycle architecture](../architecture/v0.2.md)

## Context

Canonical TFSB projects need a portable outbound artifact and stable automation
surface. Reading the existing build directory would make output depend on
staleness. Ordinary ZIP defaults leak time and may vary by compression writer.
Serializing internal CLI objects as JSON would create an accidental public API.
Preview generation also introduces an HTML boundary that must not turn the CLI
into a web application or browser-runtime package.

## Decision drivers

- Unchanged canonical state must produce identical ZIP bytes.
- Bundles must round-trip bounded SVG and companion state without carrying
  private project policy or provenance.
- Existing dependencies should be reused when they can meet a closed format.
- Automation needs deliberate versioning, deterministic order, stable
  diagnostics, and no absolute-path or environment leakage.
- Human CLI output and existing exit codes must remain compatible.
- Preview must remain static, escaped, offline, and browser-runtime-free.

## Bundle manifest alternatives

### A. Required compact manifest (selected)

A root `tfsb-manifest.json` records a closed version, generator identity,
optional project name, and a sorted inventory of file kind, name, asset ID when
applicable, and SHA-256. It has no timestamp and does not hash itself.

This enables explicit manifest-assisted re-import, verifies opaque companion
selection, and preserves asset IDs when a configured filename differs from an
ID. The importer still validates actual bytes and never trusts the manifest as
SVG or companion authority.

### B. Optional manifest

Optionality gives consumers two bundle shapes and makes round-trip behavior
conditional. It weakens the interoperability contract without reducing
implementation risk materially.

### C. No manifest

Filename-only import can recover SVG images, but not necessarily canonical
asset IDs or explicit companion inventory. It also lacks a portable checksum
inventory. This is insufficient for the stated bundle purpose.

## ZIP writer alternatives

### A. Existing pinned `fflate` with a closed store-only policy (selected)

`fflate@0.8.3` already supports explicit timestamp, origin OS, attributes,
comments, extra fields, compression level, and ordered input. Stored entries
avoid variability from DEFLATE implementation changes. A bounded spike using a
local-component 1980 date produced identical bytes under UTC and
America/New_York.

No new dependency or custom binary writer is justified. The pinned library and
golden header bytes become part of the reproducibility evidence and must be
requalified on upgrade.

### B. `fflate` DEFLATE at a fixed level

A pinned implementation is deterministic today, but compressed bytes can
change when the writer changes even if the logical ZIP policy does not. The
fixture set is small enough that size savings do not justify this additional
byte-compatibility risk.

### C. A new ZIP dependency

A different writer adds supply-chain, licensing, package-size, compatibility,
and rollback work while solving no demonstrated gap.

### D. A local ZIP writer

A minimal store-only writer is feasible, but hand-owning CRC, headers, flags,
and central-directory details creates security and maintenance surface already
covered by the pinned dependency.

## Bundle decision

Select required manifest alternative A and writer alternative A. Bundle always
starts from freshly parsed canonical state, freshly serializes selected SVGs,
and copies selected companion bytes exactly. It never reads build/install SVGs
as input and does not require derived state to be clean.

The exact ZIP policy fixes entry names/order (sorted in ascending UTF-8 byte
order of relative portable entry names), method 0, DOS timestamp, Unix
regular-file mode `0100644`, archive bit, encoding behavior, known-size headers,
and absence of directory records, extra fields, comments, ZIP64, and multi-disk
features. Output is a project-confined absent file unless explicit `--force`
authorizes a guarded replacement.

Manifest-assisted import is opt-in through `tfsb import --manifest`; default
v0.1 import behavior is unchanged. The manifest never transports build or
install policy. Bundle planning retains the importer's 1,024-entry, 128-SVG,
8-MiB-per-selected-entry, and 32-MiB aggregate selected-content limits. The
manifest has a fixed JSON key order, `files` array sorted in ascending UTF-8
byte order (Unicode code point order) of portable entry name, two-space
indentation, UTF-8 encoding, and one final LF.

Dogfood measurement retains the in-memory decision. A 128-entry method-0 proxy
at exactly 32 MiB completed with about 112 MiB maximum resident size under the
selected Node 22 runtime; 12,457 small entries totaling about 28 MiB also fit
ZIP construction alone but do not satisfy identity, profile, preview, output,
or complete-project contracts. v0.2 therefore keeps in-memory `zipSync` and its
existing ceilings. Streaming and whole-corpus bundle output remain deferred.

## JSON alternatives

### A. One versioned envelope with command-specific DTOs (selected)

Every supported command uses a closed envelope containing `schemaVersion`,
`command`, `status`, `exitCode`, `summary`, stable diagnostics, and a documented
command-specific `data` value. Core values are mapped deliberately to DTOs.

### B. Serialize internal result and plan objects

This is initially cheap but exposes filesystem paths, dependency shapes, class
layout, accidental fields, and nondeterministic map/object ordering. Internal
refactoring would become a compatibility break. It is rejected.

### C. Version each command independently without an envelope

Independent versions reduce shared structure but force consumers to discover
mode, errors, and exit meaning differently for every command. Command-specific
data is already discriminated inside the shared envelope.

## JSON decision

Select alternative A for `check`, `list`, `reconcile`, `diff`, `bundle`, `fmt`,
and `preview`. Existing `import`, `build`, and `install` JSON modes are deferred.

Status is `ok`, `drift`, `conflict`, or `error`. Exit `0` means success/clean,
`1` means invalid or failed operation, and `2` means a valid non-clean or
conflict state. This preserves existing command results and extends exit `2`
only to new inspection/check surfaces. The JSON exit field must equal the
process result.

Once JSON mode is parsed, exactly one envelope plus LF is written to stdout and
expected outcomes do not write stderr. Paths are project-relative; archive
entry names have their own field; external archive paths, tokens, environment
details, usernames, hosts, stacks, and arbitrary exception data are prohibited.
Incompatible changes require a new envelope schema version.

Machine result records for valid read-only project operations are complete and
untruncated, including a larger hand-authored v0.1 project. Human presentation
may summarize only with exact total and omitted counts plus a route to
selectors or `--json`. Mutation, bundle, or preview limit failures return an
aggregate diagnostic rather than a partial record array. v0.2 does not add
NDJSON or an optional detailed-output file.

For typed current-policy-versus-build diff, v0.2 readers continue accepting the
existing `tfsb-build-v2` ownership receipt and v0.2 builds emit
`tfsb-build-v3`. V3 adds a compact normalized, project-relative policy snapshot
for comparison only. It never authorizes build replacement and never substitutes
for current project validation. A v2 receipt remains valid but cannot supply
typed historical destination values.

## Preview decision

Preview is a static generator, not a web application. It writes HTML, a fixed
CSS file, and freshly serialized SVG files to `.tfsb-preview` (which is added to
`PROTECTED_TREES` to ensure complete disjointness from build and install
destinations). SVGs are referenced as validated same-directory image resources
rather than injected into HTML. All metadata is HTML-escaped, paths are
percent-encoded, a fixed CSP disables script and remote content, and companion
documents are never rendered.

There is no schema-1 asset taxonomy. Presentation sizes therefore derive only
from validated viewBox aspect ratio: near-square, wide, or tall. This supplies
useful Terminal Nova favicon, mark, and lockup views without a filename
heuristic or schema field. Build/install state is labeled supplementary
read-only evidence; canonical SVG is always the rendered source.

Playwright remains a development dependency used to qualify generated files.
Generation requires no browser or server. `--open` is best effort after
generation and is a no-op with an informational result in CI.

Preview remains a single page and refuses more than 128 assets. Gallery images
use native `loading="lazy"` and `decoding="async"`; no JavaScript, pagination,
search index, or per-asset page is justified at this boundary.

## Consequences

### Benefits

- Bundle identity is independent of time, host, checkout path, build drift, and
  compression implementation.
- No new runtime dependency or custom ZIP parser/writer is introduced.
- Manifest-assisted round-trip preserves useful identity without transporting
  private provenance or installation policy.
- JSON is stable by design and decoupled from human CLI and internal types.
- Preview adds useful visual inspection without active input content or runtime
  browser weight.

### Costs

- Store-only bundles are larger than DEFLATE bundles.
- The required manifest adds one reserved entry and a versioned compatibility
  obligation.
- `fflate` upgrades require bundle-byte requalification even when method 0 is
  retained.
- Automation must distinguish drift and conflict through the JSON status because
  both use exit `2`.
- Static preview deliberately omits interactive filtering and semantic asset
  categories.
- Whole external corpora must be reduced to a supported, legally reviewed
  shard before bundle or preview qualification.

## Rejected follow-on scope

This decision does not add signing, timestamps, source TOML or provenance in
bundles, executable entries, remote publishing, streaming unbounded archives,
runtime Playwright, a local server, a JavaScript gallery application, or an SVG
profile expansion. It also does not add streaming ZIP, chunked preview, NDJSON,
or a product compatibility-analysis command.
