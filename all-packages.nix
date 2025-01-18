{
  lib,
  currentSystem,
  hostpkgs ? { },
}:

let
  pkgs =
    {
      inherit lib currentSystem;
    }
    // lib.packagesFromDirectoryRecursive {
      callPackage = lib.callPackageWith (pkgs // hostpkgs);
      directory = ./packages;
    };
in
pkgs
