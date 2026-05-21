{ pkgs }:

let
  inherit (pkgs.wasmpkgs) basic-init busybox mkRootfs;
in

mkRootfs {
  name = "rootfs";
  contents = [
    basic-init
    busybox
  ];
  init = ''
    #!/bin/init
  '';
  size = "64M";
}
