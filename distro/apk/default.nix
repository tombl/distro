{
  callPackage,
  pkgs,
  tools,
}:

let
  checkStoreReferences = pkgs.writeShellApplication {
    name = "apk-check-store-references";
    runtimeInputs = [
      pkgs.findutils
      pkgs.gnugrep
    ];
    text = builtins.readFile ./check-store-references.sh;
  };
  package = callPackage ./package.nix { inherit checkStoreReferences tools; };
  repository = callPackage ./repository.nix { inherit package tools; };
  system = callPackage ./system.nix { inherit package tools; };
in
package // repository // system // { inherit checkStoreReferences; }
