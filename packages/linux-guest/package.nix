{
  busybox,
  pkgs,
  image,
  linux,
  node-workspace,
  runner,
  stdenv,
  vm-test,
}:

let
  test-program =
    name: source:
    stdenv.mkDerivation {
      pname = "linux-guest-${name}";
      version = "0.0.0";
      dontUnpack = true;
      buildPhase = ''
        $CC -Wall -Wextra -Werror -Wno-error=unused-command-line-argument \
          -Wl,--fatal-warnings -o ${name} ${source}
      '';
      installPhase = ''
        mkdir -p $out/bin
        cp ${name} $out/bin/
      '';
    };
  network-test = test-program "network-test" ./tests/network-test.c;
  user-trap = test-program "user-trap" ./tests/user-trap.c;

  lifecycle-initramfs = vm-test.mkInitramfs {
    name = "linux-guest-lifecycle";
    init = ./tests/lifecycle-init.sh;
    contents = [ busybox ];
  };

  # The directory layout tests/assets.ts consumes, via LINUX_GUEST_TEST_ASSETS
  # or by building this attribute itself.
  test-assets = pkgs.linkFarm "linux-guest-test-assets" {
    "initramfs.cpio" = "${image}/initramfs.cpio";
    "lifecycle-initramfs.cpio" = lifecycle-initramfs;
    "rootfs.squashfs" = "${image}/rootfs.squashfs";
    "network-test" = "${network-test}/bin/network-test";
    "user-trap" = "${user-trap}/bin/user-trap";
    "runner" = "${runner.package}/bin/wasm-linux-runner";
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
      cp ${image}/initramfs.cpio packages/linux-guest/initramfs.cpio
      cp ${image}/rootfs.squashfs packages/linux-guest/rootfs.squashfs

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp packages/linux-guest/package.json $out/package.json
      cp packages/linux-guest/README.md $out/README.md
      cp packages/linux-guest/LICENSE $out/LICENSE
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
        timeout --kill-after=5 300 pnpm --filter=@tombl/linux-guest-tests test

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
