{ callPackage }:

rec {
  package = callPackage ./package.nix { };
  recurseForDerivations = true;
}
