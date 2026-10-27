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
  builderImage = callPackage ./builder.nix { };
in
{
  package = callPackage ./package.nix { inherit builderImage ext4Root rootfs; };
  inherit builderImage rootfs;
  recurseForDerivations = true;
}
