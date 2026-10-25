{
  callPackage,
}:

let
  rootfs = callPackage ./rootfs.nix { };
in
{
  package = callPackage ./package.nix { inherit rootfs; };
  inherit rootfs;
  recurseForDerivations = true;
}
