{ pkgs }:

let
  inherit (pkgs) lib;
  inherit (pkgs.wasmpkgs) initramfs linux rootfs;

  runner-app = pkgs.buildNpmPackage {
    pname = "runner-app";
    version = "0.0.0";
    src = ../..;
    npmDepsHash = "sha256-TaNxUnhnxv2Q4p/IfiYFMwx9+EI3aVsG05WUOoJdGwI=";
    dontNpmBuild = true;

    preBuild = ''
      export npm_config_cache=$TMPDIR/npm-cache
      mkdir -p "$npm_config_cache"
      npm install --no-save --ignore-scripts ${linux}/linux.tgz
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp packages/runner/src/*.ts $out/
      cat > $out/package.json <<'EOF'
      {
        "type": "module",
        "dependencies": {
          "@tombl/linux": "0.0.0"
        }
      }
      EOF
      mkdir -p $out/node_modules/@tombl
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
      --disk|--disk=*) has_disk=1 ;;
      --initcpio|--initcpio=*|-i) has_initcpio=1 ;;
    esac
  done

  initcpio_args=()
  if [ "$has_initcpio" -eq 0 ]; then
    initcpio_args=(--initcpio ${initramfs}/initramfs.cpio)
  fi

  if [ "$has_disk" -eq 1 ]; then
    exec ${lib.getExe pkgs.deno} run --allow-all ${runner-app}/run.ts "''${initcpio_args[@]}" "$@"
  fi

  state_dir="''${XDG_STATE_HOME:-$HOME/.local/state}/wasm-linux"
  seed="${rootfs}/rootfs.ext4"
  disk="$state_dir/rootfs.ext4"
  stamp="$state_dir/rootfs.seed"

  mkdir -p "$state_dir"
  if [ ! -f "$disk" ] || [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$seed" ]; then
    rm -f "$disk"
    cp "$seed" "$disk"
    chmod u+w "$disk"
    printf '%s' "$seed" > "$stamp"
  fi

  exec ${lib.getExe pkgs.deno} run --allow-all ${runner-app}/run.ts "''${initcpio_args[@]}" --disk "$disk" "$@"
''
