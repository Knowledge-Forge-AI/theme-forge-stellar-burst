# TFSB2 dependency and adapter note

TFSB2 adds one runtime dependency: `fflate` 0.8.3, pinned exactly in the
package manifest and lockfile.

## `fflate` 0.8.3

- Purpose: raw DEFLATE inflation of selected ZIP entry bodies and deterministic
  ZIP generation in tests.
- Rights and compatibility: MIT licensed, compatible with this repository's
  AGPL-3.0 license.
- Runtime and footprint: pure JavaScript/TypeScript with ESM and CommonJS
  exports, no runtime dependencies, and no native addon or browser runtime
  requirement. The package supports the selected Node 22 runtime.
- Maintenance and supply chain: 0.8.3 was current at selection time, its
  published package is maintained upstream at `101arrowz/fflate`, and the
  locked runtime graph adds no transitive package. `npm audit` reported no
  known advisories at implementation time.
- Alternatives: broad archive/extraction libraries were rejected because TFSB
  does not extract directories and needs only selected raw DEFLATE inflation.
  A local DEFLATE implementation would be more security-sensitive code than
  this focused dependency. `fflate`'s public unzip metadata was not treated as
  sufficient for the TFSB safety contract.

## Safety boundary

TFSB parses ZIP end-of-central-directory, central-directory, and local-header
records itself. This exposes general-purpose flags, origin/attributes, declared
sizes, compression methods, CRCs, and local offsets needed to reject encrypted,
symlink/non-regular, ambiguous, duplicate, traversal, ZIP64, and over-limit
entries before canonical mutation. `fflate` receives only the selected raw
DEFLATE byte ranges. Its output buffer is capped; TFSB then verifies actual
inflated length, aggregate length, declared length, expansion ratio, and CRC.
Stored entries bypass inflation but receive the same length and CRC checks.

The central-directory read has an additional 64 MiB cap so the 1,024-entry
limit cannot still induce an unbounded allocation through attacker-controlled
name/extra/comment lengths. Unsupported compression on an unselected ordinary
file is inert; a selected SVG must use stored or DEFLATE compression.

## Impact and rollback

The CLI gains local ZIP import but no extraction API, remote acquisition,
browser dependency, plugin surface, or database. Rollback removes `fflate`, the
archive/import adapter and tests, and the package/lock entries; schema-1 TOML
requires no migration.
