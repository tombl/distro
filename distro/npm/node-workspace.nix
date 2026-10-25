{ pkgs }:

let
  inherit (pkgs) lib;
  pnpm = pkgs.pnpm_11;
  root = ../..;
in
{
  inherit pnpm;
  deps = pkgs.fetchPnpmDeps {
    pname = "distro-pnpm-deps";
    version = "0.0.0";
    # Only the files pnpm resolves from, so unrelated commits keep the same
    # derivation and a stale hash fails only when the lockfile changes.
    src = lib.fileset.toSource {
      inherit root;
      fileset = lib.fileset.unions [
        (root + "/pnpm-lock.yaml")
        (root + "/pnpm-workspace.yaml")
        # patchedDependencies in pnpm-workspace.yaml are applied at install.
        (lib.fileset.maybeMissing (root + "/patches"))
        (lib.fileset.fileFilter (file: file.name == "package.json") root)
      ];
    };
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-ZTBTZg2PycKS8UBC/x6SIr1fgKUZtdArvTLqYuqLCO8=";
  };
}
