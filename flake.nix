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
    };
}
