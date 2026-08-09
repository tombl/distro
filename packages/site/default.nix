{ callPackage }:

rec {
  bootFiles = callPackage ./boot-files.nix { };
  bootstrapRepository = callPackage ./bootstrap-repository.nix { };
  installDisk = callPackage ./install-disk.nix { };
  installerRepository = callPackage ./installer-repository.nix { inherit bootFiles; };
  repository = callPackage ./repository.nix { inherit bootFiles; };
  rootfs = callPackage ./rootfs.nix { repository = bootstrapRepository; };
  package = callPackage ./package.nix {
    inherit installDisk installerRepository rootfs;
  };
  recurseForDerivations = true;
}
