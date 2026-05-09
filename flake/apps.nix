{ lib, ... }:

{
  perSystem =
    {
      pkgs,
      self',
      ...
    }:
    let
      inherit (self'.legacyPackages) site;
    in
    {
      apps.runner.program = pkgs.writeShellScriptBin "wasm-linux-runner" ''
        has_disk=0
        for arg in "$@"; do
          case "$arg" in
            --disk|--disk=*) has_disk=1 ;;
          esac
        done

        if [ "$has_disk" -eq 1 ]; then
          exec ${lib.getExe pkgs.deno} run --allow-all ${site}/run.js "$@"
        fi

        state_dir="''${XDG_STATE_HOME:-$HOME/.local/state}/wasm-linux"
        seed="${site}/rootfs.ext4"
        disk="$state_dir/rootfs.ext4"
        stamp="$state_dir/rootfs.seed"

        mkdir -p "$state_dir"
        if [ ! -f "$disk" ] || [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$seed" ]; then
          rm -f "$disk"
          cp "$seed" "$disk"
          chmod u+w "$disk"
          printf '%s' "$seed" > "$stamp"
        fi

        exec ${lib.getExe pkgs.deno} run --allow-all ${site}/run.js --disk "$disk" "$@"
      '';

      apps.serve.program = pkgs.writeShellScriptBin "wasm-linux-serve" ''
        ${lib.getExe pkgs.miniserve} ${site} --index index.html \
          --header Cache-Control:no-store,no-cache,must-revalidate,max-age=0 \
          --header Pragma:no-cache \
          --header Expires:0 \
          --header Cross-Origin-Opener-Policy:same-origin \
          --header Cross-Origin-Embedder-Policy:require-corp \
          --header Cross-Origin-Resource-Policy:cross-origin "$@"
      '';
    };
}
