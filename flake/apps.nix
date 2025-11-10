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
        ${lib.getExe pkgs.deno} run --allow-all ${site}/run.js "$@"
      '';

      apps.serve.program = pkgs.writeShellScriptBin "wasm-linux-serve" ''
        ${lib.getExe pkgs.miniserve} ${site} --index index.html \
          --header Cross-Origin-Opener-Policy:same-origin \
          --header Cross-Origin-Embedder-Policy:require-corp \
          --header Cross-Origin-Resource-Policy:cross-origin "$@"
      '';
    };
}
