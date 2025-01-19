{
  lib,
  currentSystem,
  bash,
  busybox,
}:

let
  run =
    {
      path ? [ ],
      passAsFile ? [ ],
      ...
    }@args:
    command:

    derivation (
      {
        system = currentSystem;
        builder = "${bash}/bin/bash";
        args = [
          "-euc"
          ''
            if [[ -v stdenv ]]; then
              source $stdenv/setup
              build
            else
              source $commandPath
            fi
          ''
        ];
        PATH = lib.makeBinPath (
          path
          ++ [
            bash
            busybox
          ]
        );
        inherit command;
        passAsFile = [ "command" ] ++ passAsFile;
      }
      // (removeAttrs args [
        "path"
        "passAsFile"
      ])
    );

  stdenv =
    run
      {
        name = "stdenv";
        setup = ''
          : ${"$"}{outputs:=out}

          if [ 0 -eq "$NIX_BUILD_CORES" ]; then
            NIX_BUILD_CORES=$(${busybox}/bin/nproc)
          fi

          eval "_build() { $(cat $commandPath); }"
          build() {
            if [[ -v src ]]; then
              cp -r $src src
              cd src
              chmod -R u+w .
              unset src
            fi
            _build
          }
        '';
        passAsFile = [ "setup" ];
      }
      ''
        mkdir $out
        cp $setupPath $out/setup
        chmod +x $out/setup
      '';
in

args: run ({ inherit stdenv; } // args)
