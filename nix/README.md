# Burst first-party Nix source build

This recipe targets the next qualifying release. It does not change historical
v0.5.0 qualification or the current Nixpkgs PR.

The private repository exposes `.#theme-forge-stellar-burst` for
`aarch64-darwin`, `aarch64-linux`, and `x86_64-linux`. Its Darwin default remains
Nebular. Public composition maps `nix/burst/flake.nix` and `nix/burst/flake.lock`
to root `flake.nix` and `flake.lock`, where Burst becomes the default. The template
is not a standalone subflake in the private tree. The lock is an exact copy of the
existing root lock; no lock update was performed.

```sh
nix build .#theme-forge-stellar-burst
nix run .#tfsb -- --help
nix run .#tfsb-studio-service
nix build .#checks.aarch64-linux.theme-forge-stellar-burst
```

`nix/packages/stellar-burst.nix` filters source before derivation import using a
closed set of build files and source/schema roots. Project prebuilds, Git,
node_modules, prior dist, private Director source and sibling products are excluded.
The same production native builder compiles original C with Nix Node 22 headers
and the stdenv compiler. It emits the loader manifest; there is no parallel Nix
manifest producer or project-binary download. Fixup does not strip the addon after
its digest is recorded. Nix's dependency cache is separately content-addressed:
`npmDepsHash = sha256-8633Xz/V+2Amu2wRydbQJVlkJgNwkgd3d5aR4/mWlac=` was measured
from the unchanged npm lock using the selected Nixpkgs input.

Both `bin/tfsb` and `bin/tfsb-studio-service` invoke Nix Node and immutable
package-relative compiled resources independently of cwd. Wrappers unset inherited
NODE_PATH/NODE_OPTIONS; runtime dependencies remain under the output's node_modules.
Protocol schemas, native manifest/addon and legal notices are installed. Checks
exercise the exact wrappers and output with the maintained installed-product probe.

P2 freshly built the Darwin ARM64 source output and inspected its resource closure.
Automated Darwin runtime qualification remains blocked without the disposable VM.
Linux ARM64 Nix container startup failed before Nix execution; Linux x64 Nix was
not executed. These are open release cells, not supported/published claims. P5 must
supply missing native Nix runtime, effective daemon sandbox and filesystem evidence.
