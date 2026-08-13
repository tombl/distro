{
  callPackage,
  repository,
}:

let
  agentDisk = callPackage ./agent-disk.nix { inherit repository; };
  rootfs = callPackage ./rootfs.nix { inherit repository; };
  ext4Root = callPackage ./rootfs.nix {
    inherit repository;
    format = "ext4";
    size = "64M";
  };
  wrongRoot = callPackage ./rootfs.nix {
    inherit repository;
    label = "WRONG_ROOT";
  };
in
{
  package = callPackage ./package.nix {
    inherit
      agentDisk
      ext4Root
      rootfs
      wrongRoot
      ;
  };
  recurseForDerivations = true;
}
