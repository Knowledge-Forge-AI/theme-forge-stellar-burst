# First-party Theme Forge Stellar Burst Nix source package derivation (TFSB71P2-I/B).
# Consumes clean public source inputs, filters out prebuilds/node_modules/dist/private siblings,
# compiles TypeScript and original C via the unified production native builder,
# and installs immutable, cwd-independent Nix Node wrappers and protocol resources.
{ lib
, stdenv
, buildNpmPackage
, nodejs_22
, makeWrapper
, source ? null
, customSrc ? null
, npmDepsHash ? "sha256-8633Xz/V+2Amu2wRydbQJVlkJgNwkgd3d5aR4/mWlac="
}:

let
  targets = {
    aarch64-darwin = "darwin-arm64";
    x86_64-darwin = "darwin-x64";
    aarch64-linux = "linux-arm64-gnu";
    x86_64-linux = "linux-x64-gnu";
  };

  targetArtifact = targets.${stdenv.hostPlatform.system}
    or (throw "Unsupported platform for theme-forge-stellar-burst: ${stdenv.hostPlatform.system}");

  rawSrc =
    if customSrc != null then customSrc
    else if source != null then source
    else ../..;

  # Filter source to guarantee that zero prebuilt .node binaries, .git metadata,
  # node_modules, dist directories, or private monorepo siblings enter the Nix store.
  filteredSrc = lib.cleanSourceWith {
    src = rawSrc;
    name = "stellar-burst-source";
    filter = path: type:
      let
        rel = lib.removePrefix (toString rawSrc + "/") (toString path);
        files = [ "package.json" "package-lock.json" "tsconfig.json" "tsconfig.build.json"
          "LICENSE" "NOTICE" "COMMERCIAL-LICENSE.md" "README.md"
          "tools/build-directory-snapshot-native.mjs"
          "native/directory-snapshot/src/directory_snapshot.c" ];
        dirs = [ "src" "protocol" ];
      in (toString path == toString rawSrc)
        || builtins.elem rel files
        || builtins.elem rel [ "tools" "native" "native/directory-snapshot" "native/directory-snapshot/src" ]
        || (lib.any (dir: rel == dir || lib.hasPrefix (dir + "/") rel) dirs
          && !(lib.hasPrefix "src/design-director" rel)
          && type != "symlink"
          && !(lib.hasSuffix ".node" rel));
  };

in
assert builtins.hasAttr stdenv.hostPlatform.system targets;
assert !stdenv.hostPlatform.isLinux || stdenv.hostPlatform.libc == "glibc";
buildNpmPackage {
  pname = "theme-forge-stellar-burst";
  version = "0.6.1";

  src = filteredSrc;

  nodejs = nodejs_22;
  inherit npmDepsHash;

  npmFlags = [ "--ignore-scripts" ];
  npmBuildScript = "build";
  # Fixup stripping would invalidate the manifest digest emitted by the producer.
  dontStrip = true;
  # Preserve producer-authenticated ELF bytes through installation.
  dontPatchELF = true;

  nativeBuildInputs = [ makeWrapper ];

  postBuild = ''
    # Compile original C backend and produce production manifest via tools/build-directory-snapshot-native.mjs
    COMPILER_BIN="$(type -p "''${CC:-cc}")"
    echo "Building native directory snapshot addon for ${targetArtifact} with compiler: $COMPILER_BIN"
    node tools/build-directory-snapshot-native.mjs \
      --source-build \
      --artifact "${targetArtifact}" \
      --compiler "$COMPILER_BIN" \
      --node-include "${nodejs_22}/include/node" \
      --output "$PWD/native/directory-snapshot/prebuilds/${targetArtifact}"
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/lib

    # 1. Distributable compiled JavaScript and type definitions
    cp -r dist $out/dist

    # 2. Native C addon and generated production manifest
    mkdir -p $out/native/directory-snapshot/prebuilds/${targetArtifact}
    cp -r native/directory-snapshot/src $out/native/directory-snapshot/
    cp -r native/directory-snapshot/prebuilds/${targetArtifact}/* $out/native/directory-snapshot/prebuilds/${targetArtifact}/
    mkdir -p $out/tools
    cp tools/build-directory-snapshot-native.mjs $out/tools/build-directory-snapshot-native.mjs

    # 3. Protocol schemas and design evidence resources
    cp -r protocol $out/protocol

    # 4. Pruned runtime dependencies (xmldom, fflate, smol-toml)
    if [ -d node_modules ]; then
      npm prune --omit=dev --offline --ignore-scripts --no-audit --no-fund
      cp -r node_modules $out/node_modules
    fi

    # 5. Metadata and legal notices
    cp package.json $out/package.json
    if [ -f NOTICE ]; then cp NOTICE $out/NOTICE; fi
    if [ -f COMMERCIAL-LICENSE.md ]; then cp COMMERCIAL-LICENSE.md $out/COMMERCIAL-LICENSE.md; fi
    if [ -f LICENSE ]; then cp LICENSE $out/LICENSE; fi

    # 6. Immutable, cwd-independent Nix Node wrappers for tfsb and tfsb-studio-service
    makeWrapper ${nodejs_22}/bin/node $out/bin/tfsb \
      --add-flags "$out/dist/cli.js" \
      --unset NODE_PATH --unset NODE_OPTIONS

    makeWrapper ${nodejs_22}/bin/node $out/bin/tfsb-studio-service \
      --add-flags "$out/dist/service-protocol/server-cli.js" \
      --unset NODE_PATH --unset NODE_OPTIONS

    runHook postInstall
  '';

  passthru = {
    inherit targetArtifact;
    nodejs = nodejs_22;
  };

  meta = with lib; {
    description = "Declarative SVG compiler, transactional installer, and drift checker";
    homepage = "https://github.com/Knowledge-Forge-AI/theme-forge-stellar-burst";
    license = licenses.agpl3Plus;
    platforms = builtins.attrNames targets;
    mainProgram = "tfsb";
  };
}
