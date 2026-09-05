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
