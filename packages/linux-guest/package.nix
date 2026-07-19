{
  pkgs,
  guest-initramfs,
  guest-rootfs,
  linux,
  node-workspace,
  stdenv,
}:

let
  network-test = stdenv.mkDerivation {
    pname = "linux-guest-network-test";
    version = "0.0.0";
    dontUnpack = true;
    buildPhase = ''
      $CC -Wall -Wextra -Werror -Wno-error=unused-command-line-argument \
        -Wl,--fatal-warnings -o network-test ${./tests/network-test.c}
    '';
    installPhase = ''
      mkdir -p $out/bin
      cp network-test $out/bin/
    '';
  };

  # The directory layout tests/assets.ts consumes, via LINUX_GUEST_TEST_ASSETS
  # or by building this attribute itself.
  test-assets = pkgs.linkFarm "linux-guest-test-assets" {
    "initramfs.cpio" = guest-initramfs;
    "rootfs.squashfs" = guest-rootfs;
    "network-test" = "${network-test}/bin/network-test";
  };

  package = pkgs.stdenvNoCC.mkDerivation {
    pname = "linux-guest";
    inherit ((builtins.fromJSON (builtins.readFile ./package.json))) version;
    src = ../..;
    pnpmDeps = node-workspace.deps;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.pnpmConfigHook
      node-workspace.pnpm
    ];

    buildPhase = ''
      runHook preBuild

      mkdir -p checkouts/linux/tools/wasm
      tar -xzf ${linux}/linux.tgz --strip-components=1 -C checkouts/linux/tools/wasm
      pnpm --filter=@tombl/linux-guest check
      pnpm --filter=@tombl/linux-guest build
      cp ${guest-initramfs} packages/linux-guest/initramfs.cpio
      cp ${guest-rootfs} packages/linux-guest/rootfs.squashfs

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp packages/linux-guest/package.json $out/package.json
      cp packages/linux-guest/initramfs.cpio $out/initramfs.cpio
      cp packages/linux-guest/rootfs.squashfs $out/rootfs.squashfs
      cp -r packages/linux-guest/dist $out/dist
      pnpm --filter=@tombl/linux-guest pack --pack-destination $out
      mv $out/tombl-linux-guest-*.tgz $out/linux-guest.tgz

      runHook postInstall
    '';
  };

  integration = pkgs.stdenvNoCC.mkDerivation {
    pname = "linux-guest-integration-test";
    version = "0.0.0";
    src = ../..;
    pnpmDeps = node-workspace.deps;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.pnpmConfigHook
      node-workspace.pnpm
    ];

    buildPhase = ''
      runHook preBuild

      mkdir -p checkouts/linux/tools/wasm
      tar -xzf ${linux}/linux.tgz --strip-components=1 -C checkouts/linux/tools/wasm
      pnpm --filter=@tombl/linux-guest-tests check

      LINUX_GUEST_TEST_ASSETS=${test-assets} \
        timeout 180 pnpm --filter=@tombl/linux-guest-tests test

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
