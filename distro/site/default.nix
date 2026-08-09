{ callPackage }:

rec {
  bootstrapRepository = callPackage ./repository.nix { };
  rootfs = callPackage ./rootfs.nix { repository = bootstrapRepository; };
  bootFiles = callPackage ./boot-files.nix { };
  installDisk = callPackage ./install-disk.nix { };
  repository = callPackage ./repository.nix { inherit bootFiles; };
  package = callPackage ./package.nix {
    inherit installDisk repository rootfs;
  };
  recurseForDerivations = true;
}
