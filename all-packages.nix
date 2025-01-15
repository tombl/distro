{
  lib,
  inputs,
  currentSystem,
  hostpkgs ? { },
}:

let
  mkRun =
    path: args: command:
    let
      setup =
        if args ? src then
          ''
            cp -r ${args.src} src
            cd src
            chmod -R u+w .
          ''
        else
          "";
    in
    derivation (
      {
        system = currentSystem;
        builder = "${pkgs.busybox}/bin/ash";
        args = [
          "-euc"
          ''
            if [ 0 -eq "$NIX_BUILD_CORES" ]; then
              NIX_BUILD_CORES=$(${pkgs.busybox}/bin/nproc)
            fi
            exec ${pkgs.busybox}/bin/ash -eux $commandPath
          ''
        ];
        PATH = lib.makeBinPath ((args.path or [ ]) ++ path);
        command = setup + "\n" + command;
        passAsFile = [ "command" ];
      }
      // (removeAttrs args [ "srcPath" ])
    );

  run0 = mkRun [ pkgs.busybox ];

  wasmpkgs =
    {
      inherit lib inputs;
      run = mkRun {
        path = [
          pkgs.busybox
          pkgs.bash
        ];
        builder = "${pkgs.bash}/bin/bash";
      };
    }
    // lib.packagesFromDirectoryRecursive {
      callPackage = lib.callPackageWith pkgs;
      directory = ./packages;
    };
  pkgs = wasmpkgs // hostpkgs;
in
wasmpkgs
