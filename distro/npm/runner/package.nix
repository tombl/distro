{
  apk,
  bytes,
  busybox,
  pkgs,
  lib,
  kernel,
  linux-guest,
  node-workspace,
  image,
  repository,
  rootfs,
  vm-test,
}:

let
  lifecycle-rootfs = image.mkFilesystem {
    name = "linux-runner-lifecycle";
    format = "ext4";
    root = apk.mkSystem {
      name = "linux-runner-lifecycle";
      repositories = [ repository ];
      packages = [ busybox ];
      files = {
        "/init" = {
          source = ../../guest-tests/lifecycle-init.sh;
          mode = "0755";
        };
        "/vm-test-setup-dev-fd" = {
          source = ../../vm-test/setup-dev-fd.sh;
          mode = "0755";
        };
      };
    };
  };

  console-initramfs = vm-test.mkInitramfs {
    name = "linux-runner-console";
    init = ../../runner/console-init.sh;
    contents = [ busybox ];
  };

  app = pkgs.stdenvNoCC.mkDerivation {
    pname = "runner-app";
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
      rm packages/runner/node_modules/@lowland/guest
      ln -s ${linux-guest.package} packages/runner/node_modules/@lowland/guest
      pnpm --filter=@lowland/linux-runner check

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out/node_modules/@lowland/bytes $out/node_modules/@tombl
      cp packages/runner/src/run.ts $out/run.ts
      cp packages/runner/src/disk-worker.ts $out/disk-worker.ts
      cp packages/runner/src/shares.ts $out/shares.ts
      cp packages/runner/package.json $out/package.json
      cp -RL ${bytes}/. $out/node_modules/@lowland/bytes/
      cp -RL packages/runner/node_modules/@lowland/kernel $out/node_modules/@lowland/kernel
      mkdir $out/node_modules/@lowland/guest
      cp ${linux-guest.package}/package.json $out/node_modules/@lowland/guest/package.json
      cp -r ${linux-guest.package}/dist $out/node_modules/@lowland/guest/dist

      runHook postInstall
    '';
  };

  package = pkgs.writeShellScriptBin "wasm-linux-runner" ''
    has_disk=0
    for arg in "$@"; do
      case "$arg" in
        --disk | --disk=*) has_disk=1 ;;
      esac
    done

    disk_args=()
    if [ "$has_disk" -eq 0 ]; then
      disk_args=(--disk ${rootfs})
    fi

    exec ${lib.getExe pkgs.nodejs} ${app}/run.ts \
      "''${disk_args[@]}" "$@"
  '';

  integration = pkgs.stdenvNoCC.mkDerivation {
    pname = "linux-runner-integration-test";
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

      cp ${kernel}/vmlinux.wasm packages/kernel/vmlinux.wasm
      cp -r ${kernel}/dist packages/kernel/dist
      cp -r ${bytes}/dist packages/bytes/dist
      rm packages/runner/node_modules/@lowland/guest
      ln -s ${linux-guest.package} packages/runner/node_modules/@lowland/guest
      pnpm --filter=@lowland/linux-runner check
      LINUX_RUNNER_TEST_RUNNER=${package}/bin/wasm-linux-runner \
        LINUX_RUNNER_TEST_CONSOLE_INITRAMFS=${console-initramfs} \
        LINUX_RUNNER_TEST_LIFECYCLE_DISK=${lifecycle-rootfs} \
        LINUX_RUNNER_TEST_ROOT_DISK=${rootfs} \
        timeout --kill-after=5 300 pnpm --filter=@lowland/linux-runner test

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
