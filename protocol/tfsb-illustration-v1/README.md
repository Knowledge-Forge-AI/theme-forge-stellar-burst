# TFSB raster illustration metadata v1

Status: metadata contract, exported as `./illustration/v1`. The separate
`tfsb illustration` CLI validates records and explicitly invokes native-agent
generation/editing. A private installed prototype has completed one generation
and one targeted edit; this is not a public release or full illustration-lane
qualification. This metadata module does not decode, install, publish, or
activate images, and does not connect raster images to vector scenes.

## Record shape

The runtime contract is `tfsb.raster-illustration` with `schemaVersion: 1`.
Records are closed JSON objects with these fields:

```json
{
  "schema": "tfsb.raster-illustration",
  "schemaVersion": 1,
  "illustrationId": "hero-illustration",
  "revision": 1,
  "operation": "import",
  "characters": [{ "id": "captain", "revision": 2 }],
  "style": { "id": "stellar-burst", "revision": 3 },
  "provider": null,
  "model": null,
  "source": {
    "sha256": "sha256:<64 lowercase hexadecimal characters>",
    "mime": "image/png",
    "byteLength": 2048,
    "dimensions": { "width": 1024, "height": 768 },
    "alpha": "straight"
  },
  "references": [{ "id": "moodboard-1", "sha256": "sha256:<64 lowercase hexadecimal characters>" }],
  "lineage": { "parentDigest": null },
  "exportRecipes": [{ "id": "hero-webp", "recipeSha256": "sha256:<64 lowercase hexadecimal characters>", "mime": "image/webp", "width": 1200, "height": 900, "alpha": "opaque" }],
  "digest": "sha256:<64 lowercase hexadecimal characters>"
}
```

`operation` is exactly `import`, `generate`, or `edit`. An `import` record is
never relabeled as TFSB-generated: `provider` and `model` are retained only as
actual reported public facts, or `null` when unknown. Thus a historical Codex
import may correctly use either known reported values or the null/unknown form.
For generated or edited records, each of `provider` and `model` has the same
reported-or-null meaning. Neither is inferred from a filename, prompt, or local
execution context. `edit` requires a non-null `lineage.parentDigest`; `import`
and `generate` require it to be `null`.

`lineage.parentDigest` identifies the canonical **metadata record digest** of the
specific parent revision used for an edit, rather than its source-image checksum.
Retain that immutable parent record when later metadata revisions add recipes or
other facts. A source checksum separately identifies the referenced image bytes.
Validation rejects a self-reference but does not resolve an external parent or
prove its relationship to the edited pixels; retained records and the reference
inventory provide that separate lineage evidence.

The source records metadata only: SHA-256, PNG or WebP MIME, encoded byte
length, dimensions, and alpha mode (`opaque`, `straight`, `premultiplied`, or
`unknown`). The validator does not decode or inspect image bytes and therefore
does not establish that a filename, signature, dimensions, or MIME describes a
valid image. Dimensions are bounded to 16,384 per axis and 16,777,216 pixels;
encoded source bytes are bounded to 32 MiB. Character, style, reference, and
recipe collections are bounded and sorted by UTF-8 byte order. Reference
records contain only a public opaque ID and SHA-256; there are no filesystem
paths, prompts, URLs, credentials, or embedded image bytes in this contract.

Export recipes are explicit metadata (`id`, a pinned `recipeSha256`, PNG/WebP
`mime`, width, height, and alpha). The recipe digest binds a separately declared
recipe and its exact processing settings/toolchain; the record does not embed or
execute that recipe. These are plans/identities only: this source slice does not
execute an export or claim derivative bytes exist.

## Canonical identity and wire form

The digest is SHA-256 over:

```text
tfsb.raster-illustration-v1\n
<canonical UTF-8-key-sorted compact JSON projection>
```

The projection contains every record field except `digest`. Numbers are bounded
safe integers; strings are NFC, control-free, and bounded. Arrays retain their
semantic order where applicable, while identity collections are required to be
UTF-8 sorted and unique. A digest proves only the internal integrity of this
metadata record. It does not authenticate a provider, model, author, license,
or image content.

Serialized records use UTF-8, no BOM, duplicate-free canonical JSON with two
spaces and one final LF. The parser rejects noncanonical bytes, unknown fields,
duplicate keys, unsafe sizes, invalid IDs/digests, private/path-like tokens,
and contradictory operation/lineage metadata. It reuses the repository's
duplicate-free JSON primitive and applies a separate 32-level wire nesting
bound before parsing. Validation errors intentionally do not echo rejected
values.

## Saved-source record authoring

The bounded local route is invoked as
`record --request metadata.json --source saved.png|webp --mime image/png|image/webp --output NEW.json [--json]`.
It accepts a request metadata JSON file, a saved PNG or WebP source, an
explicit MIME (`image/png` or `image/webp`), and a new output path. The request
is a closed object containing only the public record
metadata (`illustrationId`, `revision`, `operation`, `characters`, `style`,
optional `provider`/`model`, `references`, `lineage`, and `exportRecipes`). It
cannot supply `schema`, `source`, `digest`, prompts, or filesystem paths; those
are rejected rather than trusted or copied into the record. An `edit` request
must provide `lineage.parentDigest` as defined above.

The route retains no-follow file and ancestor identities while reading the
source, derives the source SHA-256 and encoded byte length from the bytes
actually read, and obtains dimensions from the source inspection helper. PNG
sources are pixel-decoded for `opaque` versus `straight` alpha; WebP sources
use a strict metadata-free header check and retain `unknown` alpha. The helper
does not claim full WebP decode or export validity. The record constructor then
computes and validates the canonical metadata digest.

Output is a fresh exclusive file with mode `0600`; an existing target or
symlink is refused and the exact canonical bytes are read back before the
operation is reported complete. JSON output may include the safe record,
`recordDigest`, and source proof fields plus `metadataOnly: true` and
`providerAttested: false`. Provider/model values remain reported-or-null
metadata; this route does not authenticate a provider, model, author, license,
or image content. No provider request, image generation, Pillow dependency, or
external authoring is performed by this saved-source path.

## API boundary

`src/illustration/v1.ts` exposes the source contract, strict validator,
canonical serializer/parser, deterministic digest functions, and a small record
constructor. `src/illustration/index.ts` re-exports v1. The package exposes
`./illustration/v1`; the separate CLI and native transport own authoring and
filesystem behavior. Image decoding, derivative execution, and managed consumer
installation have separate contracts and qualification. Metadata validation
alone establishes none of those capabilities.
