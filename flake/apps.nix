{ lib, ... }:

{
  perSystem =
    {
      pkgs,
      self',
      config,
      ...
    }:
    let
      inherit (self'.legacyPackages) linux initramfs;
    in
    {
      packages.site = pkgs.runCommand "wasm-linux" { src = "${linux.src}/tools/wasm"; } ''
        mkdir $out
        cp -r $src/run.js $src/public/* $src/src $out/
        ln -s ${initramfs} $out/initramfs.cpio
        ln -sf ${linux} $out/dist
      '';

      apps.runner.program = pkgs.writeShellScriptBin "wasm-linux-runner" ''
        ${lib.getExe pkgs.deno} run --allow-read ${config.packages.site}/run.js --initcpio=${initramfs} "$@"
      '';

      apps.serve.program = pkgs.writeShellScriptBin "wasm-linux-serve" ''
        ${lib.getExe pkgs.miniserve} ${config.packages.site} --index index.html \
          --header Cross-Origin-Opener-Policy:same-origin \
          --header Cross-Origin-Embedder-Policy:require-corp \
          --header Cross-Origin-Resource-Policy:cross-origin
      '';

      make-shells.default.packages = [
        (pkgs.writeShellScriptBin "run" ''exec ${config.apps.runner.program} "$@"'')
        (pkgs.writeShellScriptBin "serve" ''exec ${config.apps.serve.program} "$@"'')
      ];
    };
}
