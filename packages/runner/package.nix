{
  pkgs,
  lib,
  initramfs,
  linux,
  rootfs,
}:

let
  app = pkgs.buildNpmPackage {
    pname = "runner-app";
    version = "0.0.0";
    src = ../..;
    npmDepsHash = "sha256-1NL9O4LvSzJMl9QLJytT5VyYyiSJecsilr26fPOw/A4=";
    dontNpmBuild = true;

    nativeBuildInputs = [ pkgs.nodejs ];

    preBuild = ''
      export npm_config_cache=$TMPDIR/npm-cache
      mkdir -p "$npm_config_cache"
      npm install --no-save --ignore-scripts ${linux}/linux.tgz
      npm run check --workspace=@tombl/linux-runner
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
  help=0
  has_initcpio=0
  for arg in "$@"; do
    case "$arg" in
      --help | -h) help=1 ;;
      --disk | --disk=*) has_disk=1 ;;
      --initcpio | --initcpio=* | -i) has_initcpio=1 ;;
    esac
  done

  initcpio_args=()
  if [ "$has_initcpio" -eq 0 ]; then
    initcpio_args=(--initcpio ${initramfs})
  fi

  if [ "$help" -eq 1 ] || [ "$has_disk" -eq 1 ]; then
    exec ${lib.getExe pkgs.nodejs} ${app}/run.ts "''${initcpio_args[@]}" "$@"
  fi

  state_dir="''${XDG_STATE_HOME:-$HOME/.local/state}/wasm-linux"
  seed="${rootfs}"
  disk="$state_dir/rootfs.ext4"
  stamp="$state_dir/rootfs.seed"

  mkdir -p "$state_dir"
  if [ ! -f "$disk" ] || [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$seed" ]; then
    rm -f "$disk"
    cp "$seed" "$disk"
    chmod u+w "$disk"
    printf '%s' "$seed" > "$stamp"
  fi

  exec ${lib.getExe pkgs.nodejs} ${app}/run.ts "''${initcpio_args[@]}" --disk "$disk" "$@"
''
