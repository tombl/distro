{
  pkgs,
  lib,
  lowland,
  node-workspace,
  rootfs,
  test-assets,
}:

let
  # The runner's sources beside the compiled lowland package and the kernel,
  # which is all of it the runner loads.
  app = pkgs.runCommand "runner-app" { } ''
    mkdir -p $out/node_modules/lowland/assets
    cp ${../../../packages/runner/src/run.ts} $out/run.ts
    cp ${../../../packages/runner/src/disk-worker.ts} $out/disk-worker.ts
    cp ${../../../packages/runner/src/shares.ts} $out/shares.ts
    cp ${../../../packages/runner/package.json} $out/package.json
    cp ${../../../packages/lowland/package.json} $out/node_modules/lowland/package.json
    cp -r ${lowland.dist}/dist $out/node_modules/lowland/dist
    cp ${lowland.assets.kernel.path} $out/node_modules/lowland/assets/${lowland.assets.kernel.name}
  '';

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

    exec ${lib.getExe pkgs.nodejs_26} ${app}/run.ts \
      "''${disk_args[@]}" "$@"
  '';

  integration = node-workspace.mkTest {
    name = "linux-runner-integration-test";
    paths = [ "packages/runner" ];
    built = {
      lowland = lowland.dist;
      assets = [ lowland.assets.kernel ];
    };
    assets = test-assets.select [
      "boot.cpio"
      "runner-console.erofs"
      "runner-lifecycle.ext4"
      "runner-rootfs.erofs"
    ];
    command = ''
      pnpm --filter=@lowland/linux-runner check
      timeout --kill-after=5 300 pnpm --filter=@lowland/linux-runner test
    '';
  };
in
package
// {
  checks.tests = integration;
}
