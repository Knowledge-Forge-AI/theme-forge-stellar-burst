# Native directory snapshot backend

This directory contains the bounded POSIX C Node-API backend selected by ADR
0011. The addon exports only the eight authenticated open, enumerate, stat,
read, and close primitives. It has no write, process, network, parsing, or
transaction authority.

Build the exact executing host artifact with:

```sh
npm run build:native
```

An explicit artifact may be supplied only when it matches the executing host:

```sh
npm run build:native -- --artifact darwin-arm64
```

The repository-owned build script locates `node_api.h` from the active Node
installation and invokes the platform C compiler directly. It uses no npm
build dependency and the package has no install-time native build script.

Generated artifacts and manifests live under `prebuilds/<artifact>/`. A
manifest binds the backend ABI, platform, Node version, compiler, normalized
command, native-source digest, artifact digest, and artifact size. An artifact
is release-qualified only after the corresponding platform, filesystem, race,
cleanup, non-inheritance, and packed-install evidence is accepted in
`docs/evaluations/v0.4-directory-snapshot-native-qualification.*`.

For the coordinated macOS release, use the declared macOS 13 deployment target
with the qualified installed compiler for both build and check:

```sh
MACOSX_DEPLOYMENT_TARGET=13.0 npm run build:native -- --artifact darwin-arm64
MACOSX_DEPLOYMENT_TARGET=13.0 npm run check:native -- --artifact darwin-arm64
```

The release qualification receipt records SDK, linker and Node-header identities
alongside the generated manifest. Different supported toolchains are qualified
with repeated matching-input builds and functional tests; they are not required
to produce the same bytes as another compiler or SDK.


## Maintained source build and next-release target matrix

Production selection now includes `linux-arm64-gnu` for actual Linux ARM64 glibc.
Required targets are `darwin-arm64`, `linux-arm64-gnu`, `linux-x64-gnu`; existing
`darwin-x64` remains in npm and reference assembly. Musl and Windows remain
unsupported. ABI 1, all eight native primitives and loader self-test remain required.
APFS/ext4 qualification is unchanged; overlayfs is not promoted to qualified storage.

```sh
node tools/build-directory-snapshot-native.mjs --source-build \
  --artifact linux-arm64-gnu --compiler /usr/bin/cc \
  --node-include /usr/local/include/node --output ./native/directory-snapshot/prebuilds/linux-arm64-gnu
node tools/assemble-burst-native.mjs --output ./native-reference-assets
node tools/report-directory-snapshot-native.mjs --diagnostic
```

The source path uses original C, explicit compiler and Node headers. It validates
runtime/target and header major version and records source, builder, complete header
content and compiler executable hashes, flags, backend/ABI and output digest/size.
Nix supplies immutable toolchain closure identity through the derivation. Release
receipts additionally bind the complete source archive and execution image. Source
manifests never label parent Git HEAD as the uncommitted build input.

Archived `build-tools/v1.mjs` and `build-tools/v2.mjs` preserve exact historical
producer bytes, including the ADDON1 producer. Assembly accepts only the current
producer or an authenticated archived digest; historical manifests are not rewritten.
`--check` always validates retained source, producer, target, digest and size.
`--check-tracked` additionally requires exact HEAD binary bytes before considering
reproducibility. For explicit-toolchain manifests, exact rebuild equality is required
when compiler executable/version, Node runtime/API and complete header hashes match.
Otherwise the result reports `integrity: "passed"`, `reproducibility: "not-applicable"`
and an unrun reason. Callers requiring exact byte reproduction use
`--check --require-reproducible`, which fails on differing toolchain identity.
The ARM64 producer-image CI check requires this mode. Missing explicit hashes fail. Historical manifests without
explicit toolchain identity retain unconditional exact rebuild equality. A matching
identity does not prove all ambient linker/SDK inputs match: any differing fresh
bytes still fail and require separate qualification.

The Linux AMD64 prebuild integrates the exact ADDON1 Debian Bookworm artifact;
see `docs/evaluations/tfsb71p4-r3b1-linux-amd64-addon-integrate1.md` for the bounded
load evidence and pending manager requalification. Intel macOS remains advisory.

The initial ARM64 release-prebuild producer is the native ARM64 Node image
`node@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844`
(Node 22.23.2, Debian GCC 12.2, glibc). The required hosted ARM64 lane is
`ubuntu-24.04-arm`; it checks producer-image bytes separately from its own toolchain
reproducibility and installed runtime. Assembly verifies actual ELF/Mach-O target
headers, manifests, source and digests, and prepares target-labelled GitHub assets.
This prepares artifacts only; no publication is performed.
