{
  callPackage,
}:

let
  agentInitramfs = callPackage ./agent-initramfs.nix { };
  rootfs = callPackage ./rootfs.nix { };
  ext4Root = callPackage ./rootfs.nix {
    format = "ext4";
    size = "64M";
  };
in
{
  package = callPackage ./package.nix { inherit agentInitramfs; };
  # The images also serve as test assets; see ../test-assets.nix.
  inherit
    agentInitramfs
    ext4Root
    rootfs
    ;
  recurseForDerivations = true;
}
