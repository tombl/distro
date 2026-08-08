{
  callPackage,
}:

let
  rootfs = callPackage ./rootfs.nix { };
in
{
  package = callPackage ./package.nix { inherit rootfs; };
  recurseForDerivations = true;
}
