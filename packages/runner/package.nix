{
  pkgs,
  lib,
  linux,
  node-workspace,
  image,
}:

let
  app = pkgs.stdenvNoCC.mkDerivation {
    pname = "runner-app";
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
      pnpm --filter=@tombl/linux-runner check

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out/node_modules/@tombl
      cp packages/runner/src/run.ts $out/run.ts
      cp packages/runner/package.json $out/package.json
      cp -RL node_modules/@tombl/linux $out/node_modules/@tombl/linux

      runHook postInstall
    '';
  };
in
pkgs.writeShellScriptBin "wasm-linux-runner" ''
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
''
