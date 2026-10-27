# Instantiates each template against this flake, in place of its `lowland`
# input, and proves the result works the way its README says it does.
{
  self,
  lib,
  pkgs,
  wasmpkgs,
}:

let
  system = pkgs.stdenv.hostPlatform.system;

  instantiate =
    path:
    let
      flake = import (path + "/flake.nix");
      outputs = flake.outputs {
        self = outputs // {
          outPath = path;
        };
        lowland = self;
      };
    in
    outputs;

  port = instantiate ./port;

  # The template's own boot script, resolving the packages it would install
  # from npm to the ones this flake builds.
  portBoot =
    pkgs.runCommand "template-port-boot"
      {
        nativeBuildInputs = [ pkgs.nodejs_26 ];
        passthru.ci.heavy = true;
      }
      ''
        cp ${./port/boot.mjs} boot.mjs
        cp ${./port/package.json} package.json
        mkdir -p node_modules
        cp -r ${wasmpkgs.lowland.package} node_modules/lowland
        timeout --kill-after=5 300 node boot.mjs ${port.packages.${system}.image} > output
        cat output
        grep -qx 'Hello from Linux on wasm!' output
        mkdir $out
      '';
in
lib.optionalAttrs (port.packages ? ${system}) {
  template-port-boot = portBoot;
}
