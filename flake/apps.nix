{lib, ...}:

{
  perSystem =
    { pkgs, self', ... }:
    let
      inherit (self'.legacyPackages) linux initramfs;
    in
    {
      apps.runner.program =
        let
          runner-lib = pkgs.runCommand "wasm-linux-runner-lib" { src = "${linux.src}/tools/wasm"; } ''
            mkdir -p $out/bin

            ln -s ${linux} $out/dist
            cp -r $src/src $out/src
            cp $src/run.js $out      
          '';
        in
        pkgs.writeShellScriptBin "wasm-linux-runner" ''
          ${lib.getExe pkgs.deno} run --allow-read ${runner-lib}/run.js --initcpio=${initramfs} "$@"
        '';

        apps.serve.program =
          let site = pkgs.runCommand "wasm-linux-site" { src = "${linux.src}/tools/wasm"; } ''
            mkdir $out
            cp -r $src/public/* $out/
            ln -s ${initramfs} $out/initramfs.cpio
            ln -sf ${linux} $out/dist
          '';
        in
        pkgs.writeShellScriptBin "wasm-linux-serve" ''
          ${lib.getExe pkgs.miniserve} ${site} --index index.html \
            --header Cross-Origin-Opener-Policy:same-origin \
            --header Cross-Origin-Embedder-Policy:require-corp \
            --header Cross-Origin-Resource-Policy:cross-origin
        '';
    };
}
