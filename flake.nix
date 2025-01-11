{
  description = "Packages for Linux on WebAssembly";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-24.11";
    flake-parts.url = "github:hercules-ci/flake-parts";

    # repo meta:
    # keep-sorted start block=yes
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

    # package sources:
    # keep-sorted start block=yes
    busybox = {
      url = "github:tombl/busybox";
      flake = false;
    };
    linux = {
      url = "github:tombl/linux/args";
      flake = false;
    };
    llvm = {
      url = "github:llvm/llvm-project/release/19.x";
      flake = false;
    };
    musl = {
      url = "github:tombl/musl/args";
      flake = false;
    };
    # keep-sorted end
  };
  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        # keep-sorted start
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
        { pkgs, system, ... }:
        {
          packages = import ./all-packages.nix {
            inherit (inputs.nixpkgs) lib;
            inherit inputs;
            currentSystem = system;
            hostpkgs = import ./host-packages.nix { inherit pkgs; };
          };
        };
    };
}
