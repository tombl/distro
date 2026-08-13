{
  callPackage,
  repository,
}:

rec {
  opfsDiskWorker = callPackage ./opfs-disk-worker.nix { };
  assets = callPackage ./assets.nix { inherit opfsDiskWorker; };
  liveFiles = callPackage ./files.nix {
    inherit assets;
    bootMode = "live";
  };
  installedFiles = callPackage ./files.nix {
    inherit assets;
    bootMode = "installed";
  };
  rootfs = callPackage ./rootfs.nix { inherit repository; };
  bootFiles = callPackage ./boot-files.nix { inherit installedFiles; };
  package = callPackage ./package.nix { inherit liveFiles rootfs; };
  recurseForDerivations = true;
}
