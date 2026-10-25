{
  callPackage,
}:

let
  rootfs = callPackage ./rootfs.nix { };
  # A writable copy of the same system for the tests.
  ext4Root = callPackage ./rootfs.nix {
    format = "ext4";
    size = "64M";
  };
in
{
  package = callPackage ./package.nix { inherit ext4Root rootfs; };
  inherit rootfs;
  recurseForDerivations = true;
}
