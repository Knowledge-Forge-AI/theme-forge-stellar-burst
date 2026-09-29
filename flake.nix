{
  description = "Theme Forge Stellar Burst - Declarative SVG compiler, transactional installer, and drift checker";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

      # Public-composition recipe: remapped to the public repository root.
      packagePath = ./nix/packages/stellar-burst.nix;
      toolsDir = ./tools;
      srcRoot = ./.;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          burst = pkgs.callPackage packagePath {
            source = srcRoot;
          };
        in
        {
          default = burst;
          theme-forge-stellar-burst = burst;
          stellar-burst = burst;
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/tfsb";
        };
        tfsb = {
          type = "app";
          program = "${self.packages.${system}.theme-forge-stellar-burst}/bin/tfsb";
        };
        tfsb-studio-service = {
          type = "app";
          program = "${self.packages.${system}.theme-forge-stellar-burst}/bin/tfsb-studio-service";
        };
      });

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          burst = self.packages.${system}.theme-forge-stellar-burst;
        in
        {
          theme-forge-stellar-burst = pkgs.runCommand "theme-forge-stellar-burst-check" {
            nativeBuildInputs = [ pkgs.nodejs_22 ];
          } ''
            node ${toolsDir}/qualify-installed-burst.mjs \
              --package-root ${burst} \
              --cli ${burst}/bin/tfsb \
              --service ${burst}/bin/tfsb-studio-service \
              --node ${pkgs.nodejs_22}/bin/node \
              --kind nix
            mkdir -p $out
            touch $out/ok
          '';
          stellar-burst = self.checks.${system}.theme-forge-stellar-burst;
        });
    };
}
