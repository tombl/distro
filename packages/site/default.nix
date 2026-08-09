{ callPackage }:

rec {
  bootFiles = callPackage ./boot-files.nix { };
  installDisk = callPackage ./install-disk.nix { };
  repository = callPackage ./repository.nix { inherit bootFiles; };
  systemRepository = callPackage ./system-repository.nix { inherit bootFiles; };
  rootfs = callPackage ./rootfs.nix { repository = systemRepository; };
  package = callPackage ./package.nix {
    inherit installDisk rootfs systemRepository;
  };
  recurseForDerivations = true;
}
