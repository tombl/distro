{
  lib,
  currentSystem,
  hostpkgs ? { },
}:

let
  inherit (lib) filterAttrs pipe;
  inherit (builtins) mapAttrs readDir;
  wasmpkgs = {
    inherit
      lib
      currentSystem
      wasmpkgs
      hostpkgs
      ;
    config = {
      debug = false;
    };
  }
  // lib.packagesFromDirectoryRecursive {
    callPackage = lib.callPackageWith (wasmpkgs // hostpkgs);
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
            outputs = mapAttrs (output: _: /${dir}/${output}) (readDir dir);
          in
          outputs
          // {
            type = "derivation";
            src = /${overrides}/${name}/src;
            outPath = outputs.out;
          }
        ))
      ]
    else
      { }
  );
in
wasmpkgs
