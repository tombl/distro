{ pkgs }:

pkgs.mkShellNoCC {
  packages = [
    pkgs.jq
    pkgs.nix-eval-jobs
  ];
}
