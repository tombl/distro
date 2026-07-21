{ lib }:

let
  nameFromPath = path: lib.concatStringsSep "-" path;

  collectChecks =
    packagePath: checkPath: value:
    if lib.isDerivation value then
      [
        {
          name = nameFromPath (packagePath ++ [ "check" ] ++ checkPath);
          inherit value;
        }
      ]
    else if builtins.isAttrs value then
      lib.concatMap (name: collectChecks packagePath (checkPath ++ [ name ]) value.${name}) (
        builtins.attrNames value
      )
    else
      throw "${nameFromPath packagePath}.checks.${nameFromPath checkPath} is not a derivation";

  collectPackage =
    path: value:
    if lib.isDerivation value then
      collectChecks path [ ] (value.checks or { })
    else if builtins.isAttrs value && (value.recurseForDerivations or false) then
      lib.concatMap (name: collectPackage (path ++ [ name ]) value.${name}) (
        builtins.attrNames (removeAttrs value [ "recurseForDerivations" ])
      )
    else
      [ ];
in
packages:
let
  checks = lib.concatMap (name: collectPackage [ name ] packages.${name}) (
    builtins.attrNames packages
  );
  names = map (check: check.name) checks;
in
assert lib.length names == lib.length (lib.unique names) || throw "package check names collide";
builtins.listToAttrs checks
