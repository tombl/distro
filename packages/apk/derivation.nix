{
  lib,
  package,
  dependency,
}:

baseStdenv:

let
  mkDerivation =
    attrsOrFunction:
    let
      attrsFunction =
        if builtins.isFunction attrsOrFunction then attrsOrFunction else _final: attrsOrFunction;
    in
    baseStdenv.mkDerivation (
      finalAttrs:
      let
        attrs = attrsFunction finalAttrs;
        shorthand = attrs.apk or null;
        declarations =
          if shorthand == null then
            attrs.apkPackages or { }
          else if attrs ? apkPackages then
            throw "guest derivation cannot define both apk and apkPackages"
          else
            {
              main = shorthand;
            };
        pname = attrs.pname or (throw "guest APK derivations require pname");
        upstreamVersion = attrs.version or (throw "guest APK derivations require version");
        common = attrs.apkCommon or { };
        revision = common.revision or 0;
        apkVersion = common.version or "${upstreamVersion}-r${toString revision}";
        mkDeclaredPackage =
          apks: key: declaration:
          let
            output = declaration.output or "out";
            binaryName = declaration.name or (if key == "main" then pname else "${pname}-${key}");
            dependsOnMain = declaration.dependsOnMain or (key != "main");
            declaredDepends = declaration.depends or [ ];
          in
          package.mkPackage (
            removeAttrs common [ "revision" ]
            // removeAttrs declaration [
              "dependsOnMain"
              "output"
            ]
            // {
              payload = lib.getOutput output finalAttrs.finalPackage;
              name = binaryName;
              version = declaration.version or apkVersion;
              origin = declaration.origin or common.origin or pname;
              depends = declaredDepends ++ lib.optional dependsOnMain (dependency.eq apks.main);
            }
          );
        apks = lib.fix (self: builtins.mapAttrs (mkDeclaredPackage self) declarations);
        existingPassthru = attrs.passthru or { };
      in
      assert lib.assertMsg (
        declarations == { } || declarations ? main
      ) "apkPackages requires a main declaration";
      removeAttrs attrs [
        "apk"
        "apkCommon"
        "apkPackages"
      ]
      // lib.optionalAttrs (declarations != { }) {
        passthru = existingPassthru // {
          guestPackage = true;
          inherit apks;
          apk = apks.main;
        };
      }
    );
in
mkDerivation
