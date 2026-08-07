{
  callPackage,
  tools,
}:

let
  package = callPackage ./package.nix { inherit tools; };
  repository = callPackage ./repository.nix { inherit package tools; };
  system = callPackage ./system.nix { inherit package tools; };
in
package // repository // system
