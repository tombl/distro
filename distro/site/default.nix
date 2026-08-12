{ callPackage }:

rec {
  assets = callPackage ./assets.nix { };
  liveFiles = callPackage ./files.nix {
    inherit assets;
    bootMode = "live";
  };
  installedFiles = callPackage ./files.nix {
    inherit assets;
    bootMode = "installed";
  };
  bootstrapRepository = callPackage ./repository.nix { };
  rootfs = callPackage ./rootfs.nix { repository = bootstrapRepository; };
  bootFiles = callPackage ./boot-files.nix { inherit installedFiles; };
  repository = callPackage ./repository.nix { inherit bootFiles; };
  package = callPackage ./package.nix { inherit liveFiles rootfs; };
  recurseForDerivations = true;
}
