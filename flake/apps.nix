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
          deno run --allow-read ${runner-lib}/run.js --initcpio=${initramfs} "$@"
        '';
    };
}
