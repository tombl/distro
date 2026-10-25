{ pkgs }:

let
  inherit (pkgs) lib;
  pnpm = pkgs.pnpm_11;
  root = ../..;

  # pnpm resolves the workspace from the lockfile and every importer's
  # manifest, so all of them take part even when only one package builds.
  manifests = lib.fileset.unions [
    (root + "/pnpm-lock.yaml")
    (root + "/pnpm-workspace.yaml")
    # patchedDependencies in pnpm-workspace.yaml are applied at install.
    (lib.fileset.maybeMissing (root + "/patches"))
    (lib.fileset.fileFilter (file: file.name == "package.json") root)
  ];
in
{
  inherit pnpm;

  # A workspace tree holding only the manifests plus the given paths, so a
  # package rebuilds (and everything downstream retests) only when its own
  # inputs change rather than on every commit.
  source =
    paths:
    lib.fileset.toSource {
      inherit root;
      fileset = lib.fileset.unions ([ manifests ] ++ map (path: root + "/${path}") paths);
    };

  deps = pkgs.fetchPnpmDeps {
    pname = "distro-pnpm-deps";
    version = "0.0.0";
    src = lib.fileset.toSource {
      inherit root;
      fileset = manifests;
    };
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-2xRK+UqVT9ZkR4ackl29TljlMDUCD/CM1OJ0wcebwAk=";
  };
}
