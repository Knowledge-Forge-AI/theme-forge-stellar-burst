# TFSB illustration carrier v1

This document defines the small, deterministic metadata contract for the first
illustration carrier. The v1 transport is a directory. The metadata module
defines the manifest, profile, and lock. The managed consumer reads the
directory, verifies derivative bytes, and installs selected outputs.

## Directory layout

The carrier uses these derived, fixed names:

```text
manifest.json
record.json
recipes/<derivative-id>.json
derivatives/<derivative-id>.png
derivatives/<derivative-id>.webp
```

Only the extension selected by a derivative's MIME is used.  The paths are
derived from validated public IDs, not accepted as caller-provided paths.

## Derivative recipes

A carrier can contain legacy derivative recipes (versions 1 and 2) and
exact-area WebP recipes (version 3). Each recipe is stored as canonical JSON
and retains its original versioned digest. Readers that predate version 3
refuse carriers containing it.

An exact-area recipe binds a PNG master by checksum and exact dimensions.
Its output preserves the complete canvas at the specified responsive size.
SVG verification reconstructs the master, checks the saved processor identity,
and compares the recomputed WebP with the carrier's stored bytes. An explicit
local-encoder comparison uses a separately computed recipe digest and verifies
the same output bytes. Installation uses the verified saved derivative.

## Manifest

The manifest schema is `tfsb.illustration-carrier`, version `1`, with these
required fields:

```json
{
  "schema": "tfsb.illustration-carrier",
  "schemaVersion": 1,
  "packageId": "<public-id>",
  "illustrationId": "<public-id>",
  "revision": 1,
  "recordDigest": "sha256:<64 lowercase hex digits>",
  "derivatives": [
    {
      "id": "<public-id>",
      "recipeDigest": "sha256:<64 lowercase hex digits>",
      "mime": "image/png",
      "sha256": "sha256:<64 lowercase hex digits>",
      "byteLength": 1,
      "width": 1,
      "height": 1,
      "alpha": "opaque"
    }
  ],
  "manifestDigest": "sha256:<64 lowercase hex digits>"
}
```

`illustrationId` binds the carrier to the authored illustration record.  The
`revision` is the immutable carrier revision selected by that record.
`derivatives` contains at least one entry, is sorted by `id`, and has no
duplicate IDs.  The manifest digest
covers the canonical JSON of the manifest without `manifestDigest`, prefixed
by the exact domain basis `tfsb-illustration-carrier-v1\n`.  IDs, counts, image
dimensions, byte lengths, and wire size are bounded by the implementation.
The revision is a positive bounded integer; this metadata contract does not
claim that any content bytes exist or match their digests.

## Consumer profile

A profile declares where a consumer wants selected derivatives placed.  Its
schema is `tfsb.illustration-consumer-profile`, version `1`:

```json
{
  "schema": "tfsb.illustration-consumer-profile",
  "schemaVersion": 1,
  "id": "<public-id>",
  "packageId": "<public-id>",
  "illustrationId": "<public-id>",
  "mappings": [
    { "derivativeId": "<public-id>", "destination": "public/images/example.png" }
  ],
  "profileDigest": "sha256:<64 lowercase hex digits>"
}
```

All fields are required.  `packageId` and `illustrationId` identify the exact
carrier family and authored illustration to which the profile applies.  There
are at most 16 mappings; derivative IDs and destinations are unique
(destinations are compared after lower-casing), and no destination may be a
file prefix of another destination (for example, `public/art.png` conflicts
with `public/art.png/detail.png`).  The list is in deterministic
derivative-ID/destination order.  The digest
covers the canonical JSON without `profileDigest`, using
`tfsb-illustration-consumer-profile-v1\n`.

Destinations are safe, public, relative paths.  Absolute paths, traversal,
backslashes, control characters, hidden/protected directories, and platform
reserved names are rejected.  Paths are bounded to 32 segments and protected
ancestors include `.git`, `.tfsb`, `.serena`, `node_modules`, and their
transaction/preview-style prefixed forms.  `manifest.json`, `record.json`,
profile/lock metadata, `.git`, `.tfsb`, `.serena`, and `node_modules` are
protected.  A profile is a declaration only; it does not authorize
installation.

## Consumer lock

A lock records the exact metadata selected by a profile and manifest.  Its
schema is `tfsb.illustration-consumer-lock`, version `1`:

```json
{
  "schema": "tfsb.illustration-consumer-lock",
  "schemaVersion": 1,
  "packageId": "<public-id>",
  "illustrationId": "<public-id>",
  "carrierRevision": 1,
  "profileDigest": "sha256:<64 lowercase hex digits>",
  "manifestDigest": "sha256:<64 lowercase hex digits>",
  "recordDigest": "sha256:<64 lowercase hex digits>",
  "mappings": [
    {
      "derivativeId": "<public-id>",
      "destination": "public/images/example.png",
      "recipeDigest": "sha256:<64 lowercase hex digits>",
      "sha256": "sha256:<64 lowercase hex digits>",
      "mime": "image/png",
      "byteLength": 1
    }
  ],
  "lockDigest": "sha256:<64 lowercase hex digits>"
}
```

All fields are required.  `packageId`, `illustrationId`, and positive bounded
`carrierRevision` bind the lock to the exact carrier identity selected by the
profile.  There are at most 16 mappings, with the same deterministic ordering,
lower-cased uniqueness, and file/directory-prefix collision rules as profiles.
This comparison is not complete Unicode case folding; installation also refuses
filesystem collisions rather than overwriting an existing target.
The digest covers
the canonical JSON without `lockDigest`, using
`tfsb-illustration-consumer-lock-v1\n`.  Lock mappings contain only the
user-declared public-relative destination and selected metadata; they do not
contain source roots, prompts, URLs, credentials, or private paths.

## Boundary

Canonical serialization, duplicate-field rejection, safe-ID/path validation,
digest calculation, and immutable returned values are part of this schema
foundation.  They establish formatting and link metadata correctness only.
They do not prove source bytes, image bytes, recipe files, or destinations
exist; they do not perform byte verification or installation; and they do not
constitute provider or runtime qualification.  Those checks remain separate
operations.
