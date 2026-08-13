{ callPackage }:

{
  package = callPackage ./package.nix { };
  recurseForDerivations = true;
}
