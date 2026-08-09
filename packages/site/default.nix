{ callPackage }:

rec {
  bootFiles = callPackage ./boot-files.nix { };
  installDisk = callPackage ./install-disk.nix { };
  repository = callPackage ./repository.nix { inherit bootFiles; };
  rootfs = callPackage ./rootfs.nix { inherit repository; };
  package = callPackage ./package.nix {
    inherit installDisk repository rootfs;
  };
  recurseForDerivations = true;
}
