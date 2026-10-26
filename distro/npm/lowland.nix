{
  bytes,
  kernel,
  linux-guest,
  lowland-image,
  node-workspace,
  pkgs,
}:

let
  # @lowland/image's test assets include a local BusyBox package, so the
  # smoke test needs no network.
  inherit (lowland-image.package.checks.tests) assets;

  # The workspace with every native artifact lowland's dependencies load
  # package-relative.
  materialize = ''
    cp ${kernel}/vmlinux.wasm packages/kernel/vmlinux.wasm
    cp -rT ${kernel}/dist packages/kernel/dist
    cp -rT ${bytes}/dist packages/bytes/dist
    cp ${linux-guest.package}/agent.img packages/linux-guest/agent.img
    cp -rT ${linux-guest.package}/dist packages/linux-guest/dist
    cp -rT ${lowland-image.package}/dist packages/image/dist
    cp ${lowland-image.builderImage} packages/image/builder.erofs
    cp ${lowland-image.rootfs} packages/image/rootfs.erofs
  '';

  package = pkgs.stdenvNoCC.mkDerivation {
    pname = "lowland";
    inherit ((builtins.fromJSON (builtins.readFile ../../packages/lowland/package.json))) version;
    src = ../..;
    env.CI = "true";
    pnpmDeps = node-workspace.deps;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.pnpmConfigHook
      node-workspace.pnpm
    ];

    buildPhase = ''
      runHook preBuild

      ${materialize}
      pnpm --filter=lowland check
      pnpm --filter=lowland test:unit
      pnpm --filter=lowland build

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      node scripts/pack-package.mjs packages/lowland --out $out/package.tgz
      tar -xzf $out/package.tgz --strip-components=1 -C $out

      runHook postInstall
    '';
  };

  # Builds an image with the command line from a local package, so it needs
  # no network, and checks that the result is an EROFS image.
  smoke = pkgs.stdenvNoCC.mkDerivation {
    pname = "lowland-smoke-test";
    version = "0.0.0";
    passthru.ci.heavy = true;
    src = ../..;
    env.CI = "true";
    pnpmDeps = node-workspace.deps;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.pnpmConfigHook
      node-workspace.pnpm
    ];

    buildPhase = ''
      runHook preBuild

      ${materialize}
      cp -rT ${package}/dist packages/lowland/dist
      echo hello >motd
      timeout --kill-after=5 600 node packages/lowland/dist/cli.js build \
        -p ${assets}/busybox.apk \
        -f motd:/etc/motd:0644 \
        -l /usr/bin/hi=/bin/busybox \
        -o image.erofs
      magic=$(od -An -tx4 -j1024 -N4 image.erofs | tr -d ' ')
      if [[ $magic != e0f5e1e2 ]]; then
        echo "lowland build wrote no EROFS image (magic $magic)" >&2
        exit 1
      fi

      runHook postBuild
    '';

    installPhase = ''
      mkdir $out
    '';
  };

  # Boots machines through lowland run and the Linux API: commands, exit
  # statuses, standard I/O, terminals, host directories, disks, and the
  # ephemeral root. Python drives lowland run on a host pseudoterminal.
  integration = pkgs.stdenvNoCC.mkDerivation {
    pname = "lowland-integration-test";
    version = "0.0.0";
    passthru.ci.heavy = true;
    src = ../..;
    env.CI = "true";
    pnpmDeps = node-workspace.deps;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.pnpmConfigHook
      pkgs.python3
      node-workspace.pnpm
    ];

    buildPhase = ''
      runHook preBuild

      ${materialize}
      LOWLAND_TEST_ASSETS=${assets} \
        timeout --kill-after=5 900 pnpm --filter=lowland test

      runHook postBuild
    '';

    installPhase = ''
      mkdir $out
    '';
  };
in
package
// {
  checks.tests = { inherit integration smoke; };
}
