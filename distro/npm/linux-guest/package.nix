{
  agentfs,
  bytes,
  busybox,
  ext4Root,
  pkgs,
  rootfs,
  wrongRoot,
  kernel,
  node-workspace,
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
  network-test = test-program "network-test" ../../guest-tests/network-test.c;
  user-trap = test-program "user-trap" ../../guest-tests/user-trap.c;
  getdents-inode = test-program "getdents-inode" ../../guest-tests/getdents-inode.c;

  lifecycle-initramfs = vm-test.mkInitramfs {
    name = "linux-guest-lifecycle";
    init = ../../guest-tests/lifecycle-init.sh;
    contents = [ busybox ];
  };

  # The directory layout tests/assets.ts consumes, via LINUX_GUEST_TEST_ASSETS
  # or by building this attribute itself.
  test-assets = pkgs.linkFarm "linux-guest-test-assets" {
    "agent.erofs" = agentfs;
    "rootfs.ext4" = ext4Root;
    "lifecycle-initramfs.cpio" = lifecycle-initramfs;
    "rootfs.erofs" = rootfs;
    "wrong-root.erofs" = wrongRoot;
    "network-test" = "${network-test}/bin/network-test";
    "user-trap" = "${user-trap}/bin/user-trap";
    "getdents-inode" = "${getdents-inode}/bin/getdents-inode";
  };

  package = pkgs.stdenvNoCC.mkDerivation {
    pname = "linux-guest";
    inherit ((builtins.fromJSON (builtins.readFile ../../../packages/linux-guest/package.json)))
      version
      ;
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

      cp ${kernel}/vmlinux.wasm packages/kernel/vmlinux.wasm
      cp -r ${kernel}/dist packages/kernel/dist
      cp -r ${bytes}/dist packages/bytes/dist
      cp ${agentfs} packages/linux-guest/agent.erofs
      pnpm --filter=@tombl/linux-guest check
      pnpm --filter=@tombl/linux-guest build

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out/node_modules/@lowland/bytes
      cp packages/linux-guest/package.json $out/package.json
      cp packages/linux-guest/README.md $out/README.md
      cp packages/linux-guest/LICENSE $out/LICENSE
      cp packages/linux-guest/agent.erofs $out/agent.erofs
      cp -r packages/linux-guest/dist $out/dist
      cp packages/bytes/package.json $out/node_modules/@lowland/bytes/package.json
      cp packages/bytes/README.md $out/node_modules/@lowland/bytes/README.md
      cp packages/bytes/LICENSE $out/node_modules/@lowland/bytes/LICENSE
      cp -r packages/bytes/dist $out/node_modules/@lowland/bytes/dist
      npm pack ./packages/linux-guest --pack-destination $out
      mv $out/tombl-linux-guest-*.tgz $out/linux-guest.tgz

      runHook postInstall
    '';
  };

  integration = pkgs.stdenvNoCC.mkDerivation {
    pname = "linux-guest-integration-test";
    version = "0.0.0";
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

      cp ${kernel}/vmlinux.wasm packages/kernel/vmlinux.wasm
      cp -r ${kernel}/dist packages/kernel/dist
      cp -r ${bytes}/dist packages/bytes/dist
      cp ${agentfs} packages/linux-guest/agent.erofs
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
