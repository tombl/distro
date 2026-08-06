{
  callPackage,
  lib,
  tools,
}:

let
  dependency = callPackage ./dependency.nix { };
  package = callPackage ./package.nix { inherit dependency tools; };
  profile = callPackage ./profile.nix { inherit package; };
  repository = callPackage ./repository.nix { inherit dependency tools; };
  system = callPackage ./system.nix { inherit tools; };
in
dependency
// package
// profile
// repository
// system
// {
  wrapStdenv =
    baseStdenv:
    baseStdenv
    // {
      mkDerivation = import ./derivation.nix {
        inherit dependency lib package;
      } baseStdenv;
    };
}
