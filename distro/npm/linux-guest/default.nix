{
  callPackage,
}:

let
  agentfs = callPackage ./agentfs.nix { };
  rootfs = callPackage ./rootfs.nix { };
  wrongRoot = callPackage ./rootfs.nix { label = "WRONG_ROOT"; };
in
{
  package = callPackage ./package.nix { inherit agentfs rootfs wrongRoot; };
  recurseForDerivations = true;
}
