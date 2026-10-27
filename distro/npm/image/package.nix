{
  bytes,
  ext4Root,
  kernel,
  linux-guest,
  node-workspace,
  pkgs,
  rootfs,
}:

let
  # The workspace with every native artifact @lowland/image and its tests load
  # package-relative.
  materialize = ''
    cp ${kernel}/vmlinux.wasm packages/kernel/vmlinux.wasm
    cp -rT ${kernel}/dist packages/kernel/dist
    cp -rT ${bytes}/dist packages/bytes/dist
    cp ${linux-guest.package}/agent.img packages/linux-guest/agent.img
    cp -rT ${linux-guest.package}/dist packages/linux-guest/dist
    cp ${rootfs} packages/image/rootfs.erofs
  '';

  package = pkgs.stdenvNoCC.mkDerivation {
    pname = "lowland-image";
    inherit ((builtins.fromJSON (builtins.readFile ../../../packages/image/package.json))) version;
    src = ../../..;
    env.CI = "true";
    pnpmDeps = node-workspace.deps;
    nativeBuildInputs = [
      pkgs.nodejs_26
      pkgs.pnpmConfigHook
      node-workspace.pnpm
    ];

    buildPhase = ''
      runHook preBuild

      ${materialize}
      pnpm --filter=@lowland/image check
      pnpm --filter=@lowland/image build

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      node scripts/pack-package.mjs packages/image --out $out/package.tgz
      tar -xzf $out/package.tgz --strip-components=1 -C $out

      runHook postInstall
    '';
  };

  integration = pkgs.stdenvNoCC.mkDerivation {
    pname = "lowland-image-integration-test";
    version = "0.0.0";
    passthru.ci.heavy = true;
    src = ../../..;
    env.CI = "true";
    pnpmDeps = node-workspace.deps;
    nativeBuildInputs = [
      pkgs.nodejs_26
      pkgs.pnpmConfigHook
      node-workspace.pnpm
    ];

    buildPhase = ''
      runHook preBuild

      ${materialize}
      LOWLAND_IMAGE_TEST_EXT4=${ext4Root} \
        timeout --kill-after=5 300 pnpm --filter=@lowland/image test

      runHook postBuild
    '';

    installPhase = ''
      mkdir $out
    '';
  };
in
package
// {
  checks.tests = {
    ext4-root = ext4Root;
    inherit integration;
  };
}
