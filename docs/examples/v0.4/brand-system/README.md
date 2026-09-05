# Expanded v0.4 brand-system examples

This tree is an implementation contract for the schemas selected by ADRs
0012–0017. It projects the ten publicly named Terminal Nova brand assets into
the new domain without copying any Terminal Nova production SVG or legal text.
All `sha256:` values are conspicuous schema-shaped example values, not receipts
or claims about external bytes.

## Directory structure

- **[producer/.tfsb](producer/.tfsb/brand.toml)**: Full Terminal Nova brand system definition, covering all seven brand domain files (retained contract for full v0.4 scope).
- **[bundle](bundle/tfsb-brand-manifest.json)**: Physical brand bundle artifacts for Terminal Nova, including generic bundle manifest v2 ([tfsb-manifest.json](bundle/tfsb-manifest.json)) and compiled brand companion manifest ([tfsb-brand-manifest.json](bundle/tfsb-brand-manifest.json)).
- **[consumer/.tfsb](consumer/.tfsb/brand.lock.json)**: Consumer installation lock ([brand.lock.json](consumer/.tfsb/brand.lock.json)) with four-location companion mapping and distinct asset digests.
- **[core-minimal](core-minimal/.tfsb/brand.toml)**: Fully self-contained, executable fixture enabling only `brand` and `package` domains with valid project TOML, canonical schema-2 asset TOMLs, companion guidance, rendered SVGs, and exact computed manifests for TFSB47B tests.
- **[vectors](vectors/canonical-digest-vectors.json)**: Authoritative golden preimages, canonical JSON strings, raw bytes, and computed SHA-256 digests for implementation verification.
- **[results](results/brand-semantic-diff.json)**: Example machine JSON envelopes for brand QA, semantic diff, visual diff, raster receipts, and Studio status.

The Terminal Nova example deliberately models the two monochrome marks as potential recipe
targets. TFSB48 must prove that the closed recipes reproduce the real current
assets exactly before transferring ownership; otherwise those assets remain
human-owned sources and the recipes are rejected. No filename inference or
silent migration is allowed.

The baseline record in `brand-qa.toml` shows exact ownership and digest fields,
but its external PNG bytes are not copied into this repository. It is therefore
a schema example, not an executable golden corpus.
