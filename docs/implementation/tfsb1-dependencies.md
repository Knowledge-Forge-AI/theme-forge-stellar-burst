# TFSB1 dependency and adapter note

TFSB1 uses two runtime packages and keeps both behind narrow decoding adapters.
The normalized TFSB model contains no DOM nodes, generic XML elements, raw
attribute maps, raw child arrays, or raw XML.

Package state, license, engine, footprint, dependency, and advisory metadata was
checked against the packages' npm records and upstream repositories on
2026-08-21: [`smol-toml`](https://www.npmjs.com/package/smol-toml),
[`@xmldom/xmldom`](https://www.npmjs.com/package/@xmldom/xmldom), and the
rejected [`fast-xml-parser`](https://www.npmjs.com/package/fast-xml-parser)
candidate and its
[published advisories](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories).

## Runtime selections

### `smol-toml` 1.8.0

- Purpose: decode TOML into unknown JavaScript values before TFSB performs its
  own closed schema validation.
- State and footprint: current at selection time, pure TypeScript/ESM, built-in
  declarations, zero runtime dependencies, about 109 KB unpacked.
- Compatibility and rights: Node 18 or newer; BSD-3-Clause, compatible with this
  repository's AGPL-3.0 license.
- Rationale: small, actively maintained, TOML 1.1-capable, and substantially
  more current than `@iarna/toml`. TFSB does not use its serializer and does not
  treat decoded objects as validated domain values.

### `@xmldom/xmldom` 0.9.12

- Purpose: well-formed XML parsing with namespace, node-kind, attribute, text,
  comment, and child-order information at the SVG adapter boundary.
- State and footprint: current at selection time, built-in declarations, zero
  runtime dependencies, about 440 KB unpacked.
- Compatibility and rights: Node 14.6 or newer; MIT, compatible with this
  repository's AGPL-3.0 license.
- Safety boundary: TFSB rejects declarations other than an optional XML
  declaration before DOM parsing, rejects DOCTYPE/entities and non-XML
  processing instructions, configures parser warnings and errors to stop rather
  than recover, never resolves or fetches resources, never uses the library
  serializer, and immediately maps accepted nodes into closed TFSB values. DOM
  parser failures are converted to stable TFSB diagnostics without exposing
  library exception text.
- Rationale: the namespace-aware zero-dependency DOM boundary makes child order,
  comments, mixed content, and unsupported node kinds explicit. A SAX parser
  (`saxes`) was rejected because its upstream repository is archived. The
  carried `fast-xml-parser` candidate was rejected because its current v5 line
  brings six runtime dependencies and has had several recent entity-expansion
  advisories; although current releases contain fixes and `processEntities:
  false` is available, it is a wider and less attractive supply-chain surface
  for this closed profile.

## Development selections

The package pins TypeScript 7.0.2, Vitest 4.1.11, and Node 22 declarations
22.20.1. TypeScript is the CLI checker and declaration emitter; Vitest runs the
Node-environment unit and fixture suites. Their Apache-2.0/MIT licenses are
compatible with AGPL-3.0. No browser, DOM-emulation, coverage, formatter,
linter, ZIP, CLI, or Playwright dependency is added in TFSB1.

The initial locked install and both full and runtime-only `npm audit` checks
reported zero known vulnerabilities. The selected xmldom patch includes the
maintainer's current parser hardening; TFSB still treats all XML as untrusted
and relies on the independent closed-profile checks above rather than package
version alone.

## Impact and rollback

At runtime the language core loads only the TOML decoder or XML parser needed by
the called API. Neither adapter performs network access. The lockfile records
the complete install graph. Rollback is removal of the package scaffold,
lockfile, adapters, and this note; no persisted project data or schema migration
is involved.

The public diagnostic operation vocabulary is intentionally limited to
`parse`, `validate`, and `serialize` for this library-only phase. The broader
`import`, `build`, `install`, and `check` sketch remains future CLI vocabulary.
