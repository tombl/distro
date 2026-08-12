{ callPackage }:

rec {
  assets = callPackage ./assets.nix { };
  bootstrapRepository = callPackage ./repository.nix { };
  rootfs = callPackage ./rootfs.nix { repository = bootstrapRepository; };
  bootFiles = callPackage ./boot-files.nix { inherit assets; };
  repository = callPackage ./repository.nix { inherit bootFiles; };
  package = callPackage ./package.nix { inherit assets rootfs; };
  recurseForDerivations = true;
}
