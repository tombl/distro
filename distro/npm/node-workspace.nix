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
rec {
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

  # Shell that puts the Nix-built package where `pnpm build` and `pnpm
  # artifacts` would leave it in a checkout: its JavaScript, and the assets
  # given as { name, path } roles from `lowland.assets`.
  installBuilt =
    {
      lowland ? null,
      assets ? [ ],
    }:
    lib.concatStringsSep "\n" (
      lib.optional (lowland != null) "cp -rT ${lowland}/dist packages/lowland/dist"
      ++ map (asset: "install -Dm0644 ${asset.path} packages/lowland/assets/${asset.name}") assets
    );

  # A check that runs a package's own scripts against the source tree, the
  # same commands a developer runs, with the built workspace packages in place
  # and $LOWLAND_TEST_ASSETS pointing at `assets`.
  mkTest =
    {
      name,
      paths,
      built,
      assets,
      command,
      nativeBuildInputs ? [ ],
      env ? { },
    }:
    pkgs.stdenvNoCC.mkDerivation {
      pname = name;
      version = "0.0.0";
      passthru.ci.heavy = true;
      src = source (
        [
          "scripts/test-assets.ts"
          "tsconfig.base.json"
        ]
        ++ paths
      );
      env = {
        CI = "true";
        LOWLAND_TEST_ASSETS = assets;
      }
      // env;
      pnpmDeps = deps;
      nativeBuildInputs = [
        pkgs.nodejs_26
        pkgs.pnpmConfigHook
        pnpm
      ]
      ++ nativeBuildInputs;

      buildPhase = ''
        runHook preBuild

        ${installBuilt built}
        ${command}

        runHook postBuild
      '';

      installPhase = ''
        touch $out
      '';
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
    hash = "sha256-Fabhw6ZOO+uYSCuirs3/9GeWv8KsXCPjTtG7TyGFbg4=";
  };
}
