{
  description = "Packages for Linux on WebAssembly";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    linux-src = {
      url = "github:tombl/linux";
      flake = false;
    };
    musl-src = {
      url = "github:tombl/musl";
      flake = false;
    };
    busybox-src = {
      url = "github:tombl/busybox/master";
      flake = false;
    };
    sqlite-src = {
      url = "https://sqlite.org/2025/sqlite-autoconf-3510000.tar.gz";
      flake = false;
    };
    llvm-src = {
      url = "https://github.com/llvm/llvm-project/releases/download/llvmorg-19.1.7/llvm-project-19.1.7.src.tar.xz";
      flake = false;
    };
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
      forEachSystem =
        fn:
        lib.genAttrs
          [
            "x86_64-linux"
            "aarch64-linux"
          ]
          (
            system:
            fn (
              import nixpkgs {
                inherit system;
                overlays = [ self.overlays.default ];
              }
            )
          );
    in
    {
      formatter = forEachSystem (pkgs: import ./formatter.nix { inherit pkgs inputs self; });
      devShells = forEachSystem (pkgs: {
        default = import ./devshells {
          inherit pkgs;
          formatter = self.formatter.${pkgs.stdenv.hostPlatform.system};
        };
        ci = import ./devshells/ci.nix { inherit pkgs; };
      });
      overlays.default = import ./overlay.nix { inherit inputs; };
      packages = forEachSystem (
        pkgs: nixpkgs.lib.filterAttrs (_name: value: lib.isDerivation value) pkgs.wasmpkgs
      );
      checks = forEachSystem (
        pkgs:
        (import ./checks.nix { inherit lib; } pkgs.wasmpkgs)
        // self.formatter.${pkgs.stdenv.hostPlatform.system}.checks
      );
      apps = forEachSystem (pkgs: {
        runner = {
          type = "app";
          program = "${pkgs.wasmpkgs.runner}/bin/wasm-linux-runner";
        };
        default = self.apps.${pkgs.system}.runner;
      });
    };
}
