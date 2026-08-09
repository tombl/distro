{ callPackage }:

rec {
  repository = callPackage ./repository.nix { };
  rootfs = callPackage ./rootfs.nix { inherit repository; };
  package = callPackage ./package.nix { inherit rootfs; };
  recurseForDerivations = true;
}
