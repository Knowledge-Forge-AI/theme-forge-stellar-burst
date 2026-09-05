# TFSB Studio protocol 1.x

The service uses strict UTF-8 NDJSON over stdin/stdout. Each frame is one JSON
object plus LF and is at most 16,777,216 bytes including LF. The schemas are
hand-maintained and closed at every authority-bearing request boundary.

`inventory.json` records the ten active TFSB45B typed plan methods alongside the
existing read-only inventory. `requests.schema.json` owns client messages,
`results.schema.json` owns common server envelopes, closed plan summaries, and
progress, and `envelope.schema.json` freezes IDs/errors.

Protocol 1.1 is an additive minor. A `1.0..1.0` range selects the exact frozen
1.0 response and artifacts. A `1.0..1.1` or `1.1..1.1` range selects 1.1.
`inventory-1.1.json`, `requests-1.1.schema.json`,
`results-1.1.schema.json`, and `examples/1.1/` describe that selected surface;
the package export remains `./studio-protocol/v1`.

Only `workspace.open`, `project.open`, and `source.open` accept absolute paths.
`project.open` optionally accepts `mode: "existing" | "import-target"`; the
latter returns an uninitialized handle consumable only by
`project.import.plan`. `source.open` optionally accepts typed auxiliary
purposes (`source-map`, `normalization-map`, or `shard-manifest`). Plan methods
use handles and normalized relative identities; they do not accept arbitrary
absolute paths or inline TOML.

In a 1.1 session, `source.open` also accepts exactly `brand-bundle` and
`npm-installed-package`. Those handles retain verified package authority and
return only sanitized identity/digest/count data. The eleven `brand.*` reads
and five `brand.*.plan` methods require a project handle; all mutation applies
continue through `plan.apply`. Brand list pages are 1..128 and bind their HMAC
cursor to protocol 1.1, method, project, page size, and domain view digest.

The session freezes raster capability at initialization. Baseline and export
plans are advertised only for the exact qualified `resvg-png-v1` tuple; all
other brand reads remain available when raster is unavailable. No result
contains an absolute path, raw TOML/SVG/PNG/RGBA/receipt bytes, plan token in a
diagnostic, or renderer filesystem identity.

Every plan result uses the closed wrapper
`{ planToken, planDigest, expiresInMs: 600000, method, summary }`. Tokens are
32 random bytes encoded as 43-character unpadded base64url strings. The
reconciliation summary uses the exact archive and directory classification,
planned-action, and required-authority vocabularies.

## Protocol 1.2

Protocol identifier remains `tfsb.studio`; supported versions are exactly
1.0, 1.1, and 1.2. Files without a suffix are frozen 1.0. The `-1.1` files and
examples are frozen. Protocol 1.2 is defined by
`requests-1.2.schema.json`, `results-1.2.schema.json`,
`inventory-1.2.json`, and `examples/1.2/`.

Version 1.2 adds exactly `brand.qa.profile.list` and
`brand.visual.evidence.get`. The inventory is 41 request methods, three client
notifications, one server notification, and the unchanged 21-error registry.
QA-profile cursors bind version 1.2, method, project, page size, project and QA
digests, and last profile ID. Visual evidence uses PNG/base64 only and the
closed limits and digest projection in ADR 0020. It never transports SVG,
HTML, CSS, filesystem paths, renderer paths, receipts, or persistent files.
