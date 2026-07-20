{ callPackage }:

rec {
  mkBundle = callPackage ./bundle.nix { };
  mkInitramfs = callPackage ./initramfs.nix { };
  mkRootfs = callPackage ./rootfs.nix { };
  mkGuestRootfs = callPackage ./guest-rootfs.nix { inherit mkRootfs; };

  bootInitramfs = callPackage ./boot-initramfs.nix { inherit mkInitramfs; };

  recurseForDerivations = true;
}
