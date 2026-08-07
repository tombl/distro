{ callPackage }:

rec {
  mkBundle = callPackage ./bundle.nix { };
  mkInitramfs = callPackage ./initramfs.nix { };
  mkFilesystem = callPackage ./filesystem.nix { };

  bootInitramfs = callPackage ./boot-initramfs.nix { inherit mkInitramfs; };

  recurseForDerivations = true;
}
