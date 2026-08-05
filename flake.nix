{
  description = "Packages for Linux on WebAssembly";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  nixConfig = {
    extra-substituters = [ "https://linuxwasm.cachix.org" ];
    extra-trusted-public-keys = [
      "linuxwasm.cachix.org-1:+z2SehaESo/3sYp7afTgyXBHUkSj/Y+BokzAkWZEmeM="
    ];
  };

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      eachSystem =
        fn:
        lib.genAttrs
          [
            "x86_64-linux"
            "aarch64-linux"
            "aarch64-darwin"
          ]
          (
            system:
            fn {
              pkgs = import nixpkgs { inherit system; };
              wasmpkgs = self.legacyPackages.${system};
              formatter = self.formatter.${system};
            }
          );
      isPackage =
        _name: value:
        lib.isDerivation value || (builtins.isAttrs value && lib.isDerivation (value.package or null));
      packageFrom = _name: value: if lib.isDerivation value then value else value.package;
    in
    {
      # The package scope is the product. It contains owner-oriented package
      # sets and non-derivation helpers, hence legacyPackages rather than only
      # the flat packages output.
      legacyPackages = eachSystem ({ pkgs, ... }: import ./packages { inherit pkgs; });

      # legacyPackages preserves the owner-oriented package sets. The packages
      # output projects each set's primary derivation back to the conventional
      # flat flake interface, so `nix build .#site` remains the obvious command
      # while `legacyPackages.${system}.site.image.rootfs` stays navigable.
      packages = eachSystem (
        { wasmpkgs, ... }: lib.mapAttrs packageFrom (lib.filterAttrs isPackage wasmpkgs)
      );

      checks = eachSystem (
        {
          pkgs,
          wasmpkgs,
          formatter,
        }:
        import ./checks.nix { inherit lib; } wasmpkgs
        // {
          formatting = pkgs.runCommand "treefmt-check" { nativeBuildInputs = [ formatter ]; } ''
            cp -r ${self} tree
            chmod -R u+w tree
            cd tree
            treefmt --ci
            touch $out
          '';
        }
      );

      formatter = eachSystem ({ pkgs, ... }: import ./formatter.nix { inherit pkgs; });

      devShells = eachSystem (
        {
          pkgs,
          wasmpkgs,
          formatter,
        }:
        {
          default = pkgs.mkShellNoCC {
            packages = [
              formatter
              wasmpkgs.go-toolchain.package
              wasmpkgs.llvm-toolchain
              pkgs.cmake
              pkgs.ninja
              pkgs.nodejs
              pkgs.pnpm_11
            ];
            env = {
              inherit (wasmpkgs.platform.system.go) GOOS GOARCH;
              CGO_ENABLED = "0";
              GOTOOLCHAIN = "local";
              sysroot = "${wasmpkgs.sysroot}";
            };
          };

        }
      );

      apps = eachSystem (
        { pkgs, wasmpkgs, ... }:
        {
          runner = {
            type = "app";
            program = lib.getExe wasmpkgs.runner.package;
          };

          default = self.apps.${pkgs.stdenv.hostPlatform.system}.runner;
        }
      );

    };
}
