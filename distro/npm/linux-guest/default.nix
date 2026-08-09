{
  callPackage,
}:

let
  agentfs = callPackage ./agentfs.nix { };
  rootfs = callPackage ./rootfs.nix { };
  ext4Root = callPackage ./rootfs.nix {
    format = "ext4";
    size = "64M";
  };
  wrongRoot = callPackage ./rootfs.nix { label = "WRONG_ROOT"; };
in
{
  package = callPackage ./package.nix {
    inherit
      agentfs
      ext4Root
      rootfs
      wrongRoot
      ;
  };
  recurseForDerivations = true;
}
