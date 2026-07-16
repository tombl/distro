{
  description = "Packages for Linux on WebAssembly";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    # keep-sorted start block=yes
    busybox-src = {
      url = "github:tombl/busybox/7e538434a144f9ea75d764a4e3f380a00fb80bac";
      flake = false;
    };
    linux-src = {
      url = "github:tombl/linux/a1b17a90f467e788492acad5434c2376062a9c95";
      flake = false;
    };
    llvm-src = {
      url = "github:tombl/llvm-project/ff5671ca630630276cc185db3e017305eae59bc1";
      flake = false;
    };
    musl-src = {
      url = "github:tombl/musl/314d4e81e26546ba063663437657095ad2c0351c";
      flake = false;
    };
    sqlite-src = {
      url = "https://sqlite.org/2025/sqlite-autoconf-3510000.tar.gz";
      flake = false;
    };
    # keep-sorted end
  };

  nixConfig = {
    extra-substituters = [ "https://linuxwasm.cachix.org" ];
    extra-trusted-public-keys = [
      "linuxwasm.cachix.org-1:+z2SehaESo/3sYp7afTgyXBHUkSj/Y+BokzAkWZEmeM="
    ];
  };

  outputs =
    { self, nixpkgs, ... }@inputs:
    let
      inherit (nixpkgs) lib;
      eachSystem =
        fn:
        lib.genAttrs
          [
            "x86_64-linux"
            "aarch64-linux"
            "x86_64-darwin"
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
    in
    {
      # The package scope is the product: a flat attrset in the style of a
      # nixpkgs sub-scope. It contains a few non-derivation members (platform,
      # vm-test helpers), hence legacyPackages rather than packages.
      legacyPackages = eachSystem ({ pkgs, ... }: import ./packages { inherit pkgs inputs; });

      packages = eachSystem ({ wasmpkgs, ... }: lib.filterAttrs (_name: lib.isDerivation) wasmpkgs);

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
              wasmpkgs.llvm-toolchain
              pkgs.cmake
              pkgs.deno
              pkgs.ninja
              pkgs.nodejs
            ];
            env.sysroot = "${wasmpkgs.sysroot}";
          };

          ci = pkgs.mkShellNoCC {
            packages = [
              pkgs.jq
              pkgs.nix-eval-jobs
            ];
          };
        }
      );

      apps = eachSystem (
        { pkgs, wasmpkgs, ... }:
        {
          runner = {
            type = "app";
            program = lib.getExe wasmpkgs.runner;
          };

          serve = {
            type = "app";
            program = lib.getExe (
              pkgs.writeShellScriptBin "wasm-linux-serve" ''
                ${lib.getExe pkgs.miniserve} ${wasmpkgs.site} --index index.html \
                  --header Cache-Control:no-store,no-cache,must-revalidate,max-age=0 \
                  --header Pragma:no-cache \
                  --header Expires:0 \
                  --header Cross-Origin-Opener-Policy:same-origin \
                  --header Cross-Origin-Embedder-Policy:require-corp \
                  --header Cross-Origin-Resource-Policy:cross-origin "$@"
              ''
            );
          };

          default = self.apps.${pkgs.stdenv.hostPlatform.system}.runner;
        }
      );
    };
}
