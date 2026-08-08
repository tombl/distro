{
  busybox,
  pkgs,
  lib,
  linux,
  linux-guest,
  node-workspace,
  image,
  vm-test,
}:

let
  lifecycle-initramfs = vm-test.mkInitramfs {
    name = "linux-runner-lifecycle";
    init = ../linux-guest/tests/lifecycle-init.sh;
    contents = [ busybox ];
  };

  app = pkgs.stdenvNoCC.mkDerivation {
    pname = "runner-app";
    version = "0.0.0";
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

      mkdir -p checkouts/linux/tools/wasm
      tar -xzf ${linux}/linux.tgz --strip-components=1 -C checkouts/linux/tools/wasm
      rm packages/runner/node_modules/@tombl/linux-guest
      ln -s ${linux-guest.package} packages/runner/node_modules/@tombl/linux-guest
      pnpm --filter=@tombl/linux-runner check

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out/node_modules/@tombl
      cp packages/runner/src/run.ts $out/run.ts
      cp packages/runner/src/shares.ts $out/shares.ts
      cp packages/runner/package.json $out/package.json
      cp -RL node_modules/@tombl/linux $out/node_modules/@tombl/linux
      mkdir $out/node_modules/@tombl/linux-guest
      cp ${linux-guest.package}/package.json $out/node_modules/@tombl/linux-guest/package.json
      cp -r ${linux-guest.package}/dist $out/node_modules/@tombl/linux-guest/dist

      runHook postInstall
    '';
  };

  package = pkgs.writeShellScriptBin "wasm-linux-runner" ''
    has_disk=0
    has_initcpio=0
    for arg in "$@"; do
      case "$arg" in
        --disk | --disk=*) has_disk=1 ;;
        --initcpio | --initcpio=* | -i) has_initcpio=1 ;;
      esac
    done

    initcpio_args=()
    if [ "$has_initcpio" -eq 0 ]; then
      initcpio_args=(--initcpio ${image}/initramfs.cpio)
    fi

    disk_args=()
    if [ "$has_disk" -eq 0 ]; then
      disk_args=(--disk ${image}/rootfs.squashfs)
    fi

    exec ${lib.getExe pkgs.nodejs} ${app}/run.ts \
      "''${initcpio_args[@]}" "''${disk_args[@]}" "$@"
  '';

  integration = pkgs.stdenvNoCC.mkDerivation {
    pname = "linux-runner-integration-test";
    version = "0.0.0";
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

      mkdir -p checkouts/linux/tools/wasm
      tar -xzf ${linux}/linux.tgz --strip-components=1 -C checkouts/linux/tools/wasm
      rm packages/runner/node_modules/@tombl/linux-guest
      ln -s ${linux-guest.package} packages/runner/node_modules/@tombl/linux-guest
      pnpm --filter=@tombl/linux-runner check
      LINUX_RUNNER_TEST_RUNNER=${package}/bin/wasm-linux-runner \
        LINUX_RUNNER_TEST_LIFECYCLE_INITRAMFS=${lifecycle-initramfs} \
        timeout --kill-after=5 300 pnpm --filter=@tombl/linux-runner test

      runHook postBuild
    '';

    installPhase = ''
      mkdir $out
    '';
  };
in
package
// {
  checks.tests = integration;
}
