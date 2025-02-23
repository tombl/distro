{
  lib,
  currentSystem,
  hostpkgs ? { },
}:

let
  inherit (lib) filterAttrs pipe;
  inherit (builtins) mapAttrs readDir;
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
    }
    // (
      let
        isImpure = builtins ? currentSystem;
        overrides = builtins.getEnv "DISTRO_OVERRIDES";
      in
      if isImpure && overrides != "" then
        pipe overrides [
          readDir
          (filterAttrs (_name: type: type == "directory"))
          (mapAttrs (name: _: /${overrides}/${name}/outputs))
          (mapAttrs (
            name: dir:
            let
              pkg = (mapAttrs (output: _: /${dir}/${output}) (readDir dir)) // {
                type = "derivation";
                src = /${overrides}/${name}/src;
                outPath = pkg.out;
              };
            in
            pkg
          ))
        ]
      else
        { }
    );
in
pkgs
