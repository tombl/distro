{ pkgs }:

let
  pnpm = pkgs.pnpm_11;
in
{
  inherit pnpm;
  deps = pkgs.fetchPnpmDeps {
    pname = "distro-pnpm-deps";
    version = "0.0.0";
    src = ../..;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-roifLz3wkOgtSFCOuGX5zIvYNP69/9wXXUdxM5FRNkw=";
  };
}
