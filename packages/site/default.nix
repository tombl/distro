{ callPackage }:

rec {
  bootstrapRepository = callPackage ./bootstrap-repository.nix { };
  installDisk = callPackage ./install-disk.nix { };
  repository = callPackage ./repository.nix { };
  rootfs = callPackage ./rootfs.nix { repository = bootstrapRepository; };
  package = callPackage ./package.nix { inherit installDisk rootfs; };
  recurseForDerivations = true;
}
