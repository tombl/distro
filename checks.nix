{ lib }:

let
  pathName =
    path:
    lib.pipe path [
      (map (builtins.replaceStrings [ "_" "." "/" ] [ "-" "-" "-" ]))
      (lib.concatStringsSep "-")
    ];

  collectTests =
    packagePath: testPath: value:
    if lib.isDerivation value then
      let
        testName = pathName (if testPath == [ ] then [ "default" ] else testPath);
      in
      {
        "pkg-${pathName packagePath}-test-${testName}" = value;
      }
    else if lib.isAttrs value then
      lib.concatMapAttrs (name: collectTests packagePath (testPath ++ [ name ])) value
    else
      { };

  collectPackages =
    packagePath: value:
    if lib.isDerivation value then
      {
        "pkg-${pathName packagePath}" = value;
      }
      // collectTests packagePath [ ] (value.passthru.tests or { })
    else if lib.isAttrs value && (value.recurseForDerivations or false) then
      lib.concatMapAttrs (name: collectPackages (packagePath ++ [ name ])) (
        removeAttrs value [ "recurseForDerivations" ]
      )
    else
      { };
in
packages: lib.concatMapAttrs (name: collectPackages [ name ]) packages
