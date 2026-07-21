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
    hash = "sha256-wiVUN2W14LrWyJ4nya4K5OUlkxYdYt8gx6yTVewKoik=";
  };
}
