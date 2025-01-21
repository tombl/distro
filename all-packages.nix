{
  lib,
  currentSystem,
  hostpkgs ? { },
}:

let
  pkgs =
    {
      inherit lib currentSystem;
      config = {
        debug = false;
      };
    }
    // lib.packagesFromDirectoryRecursive {
      callPackage = lib.callPackageWith (pkgs // hostpkgs);
      directory = ./packages;
    };
in
pkgs
