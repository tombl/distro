{
  callPackage,
  repository,
}:

rec {
  liveFiles = callPackage ./files.nix {
    bootMode = "live";
  };
  installedFiles = callPackage ./files.nix {
    bootMode = "installed";
  };
  rootfs = callPackage ./rootfs.nix { inherit repository; };
  bootFiles = callPackage ./boot-files.nix { inherit installedFiles; };
  package = callPackage ./package.nix { inherit liveFiles rootfs; };
  recurseForDerivations = true;
}
