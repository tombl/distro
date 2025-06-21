{
  description = "Packages for Linux on WebAssembly";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    # keep-sorted start block=yes
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    make-shell = {
      url = "github:nicknovitski/make-shell";
    };
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # keep-sorted end
  };

  nixConfig = {
    extra-substituters = [ "https://nix.tombl.net/linuxwasm" ];
    extra-trusted-public-keys = [ "linuxwasm:VY2O9prGSkyVY+xn1RNQV4voLVTnc2FOxAtzf8VbZaw=" ];
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        # keep-sorted start
        ./flake/apps.nix
        ./flake/format.nix
        ./flake/git-hooks.nix
        ./flake/shell.nix
        # keep-sorted end
      ];

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        {
          pkgs,
          system,
          config,
          lib,
          ...
        }:
        {
          # For better or for worse, nixpkgs has established the pattern of
          # a legacyPackages attribute that does not contain legacy packages at all,
          # but rather an attribute set that's just not the shape of the typical packages attribute.
          # In our case, we have a handful of non-package attributes that we still want to expose under the pkgs object.
          legacyPackages = import ./all-packages.nix {
            inherit (inputs.nixpkgs) lib;
            currentSystem = system;
            hostpkgs = import ./host-packages.nix {
              inherit pkgs;
              wasmpkgs = config.legacyPackages;
            };
          };

          # and then expose a filtered version of that attribute set with just the actual packages.
          packages = lib.filterAttrs (_name: value: value ? drvPath) config.legacyPackages;
          checks = config.packages;
        };
    };
}
