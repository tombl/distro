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
      inherit (self'.legacyPackages) site;
    in
    {
      apps.runner.program = pkgs.writeShellScriptBin "wasm-linux-runner" ''
        ${lib.getExe pkgs.deno} run --allow-read ${site}/run.js "$@"
      '';

      apps.serve.program = pkgs.writeShellScriptBin "wasm-linux-serve" ''
        ${lib.getExe pkgs.miniserve} ${site} --index index.html \
          --header Cross-Origin-Opener-Policy:same-origin \
          --header Cross-Origin-Embedder-Policy:require-corp \
          --header Cross-Origin-Resource-Policy:cross-origin "$@"
      '';

      make-shells.default.packages = [
        (pkgs.runCommand "dev-commands" { } ''
          mkdir -p $out/bin
          ln -s ${config.apps.runner.program} $out/bin/run
          ln -s ${config.apps.serve.program} $out/bin/serve
        '')
      ];
    };
}
