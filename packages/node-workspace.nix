{ pkgs }:

let
  pnpm = pkgs.pnpm_11;
in
{
  inherit pnpm;
  deps = pkgs.fetchPnpmDeps {
    pname = "distro-pnpm-deps";
    version = "0.0.0";
    src = ../.;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-yqqQ6cJ2++r6u2fyRvhwdac9QPA2XFMugM8bNbOnT4A=";
  };
}
