{ callPackage }:

rec {
  bootstrapRepository = callPackage ./bootstrap-repository.nix { };
  repository = callPackage ./repository.nix { };
  rootfs = callPackage ./rootfs.nix { repository = bootstrapRepository; };
  package = callPackage ./package.nix { inherit rootfs; };
  recurseForDerivations = true;
}
