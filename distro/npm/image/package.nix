{
  builderImage,
  bytes,
  ext4Root,
  jq,
  kernel,
  lib,
  linux-guest,
  mkImage,
  node-workspace,
  pkgs,
  rootfs,
}:

let
  # mkImage's passthru carries the APKs it would install; reading them does
  # not build the image itself.
  testPackages = lib.listToAttrs (
    map (package: lib.nameValuePair package.name package)
      (mkImage {
        name = "lowland-image-test-packages";
        packages = [ jq ];
      }).packages
  );
  jqPackage = testPackages.jq;

  # The directory layout test/assets.ts consumes, via LOWLAND_IMAGE_TEST_ASSETS
  # or by building this attribute itself. A local package keeps the build
  # helper test hermetic in the network-less Nix sandbox.
  test-assets = pkgs.linkFarm "lowland-image-test-assets" {
    "jq.apk" = "${jqPackage}/${jqPackage.filename}";
    "rootfs.ext4" = ext4Root;
  };

  # The workspace with every native artifact @lowland/image and its tests load
  # package-relative.
  materialize = ''
    cp ${kernel}/vmlinux.wasm packages/kernel/vmlinux.wasm
    cp -rT ${kernel}/dist packages/kernel/dist
    cp -rT ${bytes}/dist packages/bytes/dist
    cp ${linux-guest.package}/agent.img packages/linux-guest/agent.img
    cp -rT ${linux-guest.package}/dist packages/linux-guest/dist
    cp ${rootfs} packages/image/rootfs.erofs
    cp ${builderImage} packages/image/builder.erofs
  '';

  package = pkgs.stdenvNoCC.mkDerivation {
    pname = "lowland-image";
    inherit ((builtins.fromJSON (builtins.readFile ../../../packages/image/package.json))) version;
    src = ../../..;
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
      pkgs.nodejs
      pkgs.pnpmConfigHook
      node-workspace.pnpm
    ];

    buildPhase = ''
      runHook preBuild

      ${materialize}
      LOWLAND_IMAGE_TEST_ASSETS=${test-assets} \
        timeout --kill-after=5 600 pnpm --filter=@lowland/image test

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
    assets = test-assets;
    inherit integration;
  };
}
