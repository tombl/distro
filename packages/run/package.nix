{
  lib,
  currentSystem,
  bash,
  busybox,
}:

{
  path ? [ ],
  src ? null,
  ...
}@args:
command:

let
  setup =
    if src != null then
      ''
        cp -r ${src} src
        cd src
        chmod -R u+w .
      ''
    else
      "";
in

derivation (
  {
    system = currentSystem;
    builder = "${bash}/bin/bash";
    args = [
      "-euc"
      ''
        if [ 0 -eq "$NIX_BUILD_CORES" ]; then
          NIX_BUILD_CORES=$(${busybox}/bin/nproc)
        fi
        exec ${bash}/bin/bash -euxo pipefail $commandPath
      ''
    ];
    PATH = lib.makeBinPath (
      path
      ++ [
        bash
        busybox
      ]
    );
    command = setup + "\n" + command;
    passAsFile = [ "command" ];
  }
  // (removeAttrs args [
    "path"
  ])
)
