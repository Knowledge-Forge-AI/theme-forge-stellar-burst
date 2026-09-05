# TFSB design evidence protocol v1

This folder defines the portable, file-based human-agent design exchange used
by TFSB Studio v0.1. It is not a `tfsb.studio` JSON-RPC protocol version and
grants no plan, mutation, filesystem, provider, model, authorship, or licensing
authority.

The three closed packet schemas are `tfsb.design-brief`,
`tfsb.design-candidate`, and `tfsb.design-review`, each at `schemaVersion: 1`.
Packet files use `.tfsb-brief.json`, `.tfsb-candidate.json`, or
`.tfsb-review.json`. Imported bytes must be strict UTF-8 without BOM or
duplicate keys and must already equal canonical UTF-8-key-sorted two-space JSON
with one final LF.

All strings are strict UTF-8 and NFC. Single-line text rejects NUL, CR, LF,
other C0 controls, and DEL. Designated multiline text permits LF only. General
IDs are 1..128 UTF-8 bytes and match
`^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`. Package IDs are 1..214 UTF-8 bytes and
use the existing TFSB npm-style package grammar: an unscoped lowercase package
component or `@scope/package`, where each component starts with lowercase
ASCII alphanumeric and then contains only lowercase alphanumeric, `.`, `_`,
or `-`. Render backgrounds are exactly `transparent`, `#RRGGBBAA`, or
`token:[a-z][a-z0-9]*(?:-[a-z0-9]+)*`.

Exact array and text limits are: 16,777,216 encoded bytes per packet;
8,388,608 decoded visual bytes; 0..8 brief and 1..8 candidate visual records;
1..32 targets; 1..16 render tuples; 1..8 candidate packets; 1..64 acceptance
criteria; 0..64 prohibited changes; 1..8 source packages; 1..32 install
profile IDs; optional sync profile IDs 1..32; 0..32 parameter selections;
0..32 values per profile; 1..512 UTF-8 bytes per parameter value; 1..256
bytes per license expression; 0..64 materials; 0..64 claims; and 0..128
annotations. Other plain text is field-bounded and never exceeds 4,096 UTF-8
bytes; annotation comments never exceed 2,048 bytes. Visuals reuse the complete
`tfsb.studio-visual-evidence` schema-1 authority.

Identity sets are unique and sorted by UTF-8 bytes: brief targets by target ID;
allowed proposal kinds; required token, recipe, and QA IDs; materials by kind,
identifier, and digest; source packages by package ID; profile, recipe, output,
and parameter selections; candidate digests; annotations by annotation ID; and
dispositions by candidate digest. Visual and artifact arrays preserve semantic
order. Artifact roles are exactly `current`, `baseline`, `before`, and `after`.
An overall `preferred`, `approved`, or `needs-revision` disposition names the
one candidate with that same per-candidate disposition. `rejected-all` requires
all candidates to be rejected. `no-decision` cannot coexist with a preferred
or approved candidate, and export requires at least one reviewed candidate.

The self-digests exclude only their own digest field and hash the canonical
packet projection after these exact domain bases:

```text
tfsb.design-brief-v1\n
tfsb.design-candidate-v1\n
tfsb.design-review-v1\n
```

Digests prove internal integrity only. Author and material fields are
self-asserted provenance; they do not authenticate a sender, determine
copyright ownership, or establish a license conclusion.

`inventory.json`, the JSON Schemas, examples, and shared negative corpus are
generated/checkable machine records. Core, Rust, and browser validators consume
the same examples and negative cases independently; neither Studio validator
imports the core runtime validator.
