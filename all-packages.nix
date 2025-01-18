{
  lib,
  inputs,
  currentSystem,
  hostpkgs ? { },
}:

let
  wasmpkgs =
    {
      inherit lib inputs currentSystem;
    }
    // lib.packagesFromDirectoryRecursive {
      callPackage = lib.callPackageWith pkgs;
      directory = ./packages;
    };
  pkgs = wasmpkgs // hostpkgs;
in
wasmpkgs
