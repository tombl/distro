{
  pkgs,
  lib,
  tools,
  platform,
  package,
}:

let
  mkRepository =
    {
      name,
      packages,
      arch ? platform.apkArch,
      description ? name,
      signingKey ? null,
    }:
    let
      packageList = lib.concatLists (
        lib.mapAttrsToList (
          key: value:
          if builtins.isAttrs value && (value.isApk or false) then
            [ value ]
          else if lib.isDerivation value then
            [ (package.mkPackageFrom value) ]
          else
            throw "repository member ${key} is not a derivation or APK package"
        ) packages
      );
      sortedPackages = builtins.sort (
        left: right: "${left.name}-${left.version}" < "${right.name}-${right.version}"
      ) packageList;
      identities = map (
        apkPackage: "${apkPackage.arch}/${apkPackage.name}-${apkPackage.version}"
      ) sortedPackages;
      duplicateIdentities = builtins.filter (
        identity: lib.count (candidate: candidate == identity) identities > 1
      ) (lib.unique identities);
    in
    assert lib.assertMsg (packageList != [ ]) "APK repository ${name} contains no packages";
    assert lib.assertMsg (duplicateIdentities == [ ])
      "APK repository ${name} contains duplicate packages: ${lib.concatStringsSep ", " duplicateIdentities}";
    pkgs.runCommand "${name}-apk-repository"
      {
        nativeBuildInputs = [ tools ];
        passthru = {
          isApkRepository = true;
          inherit arch name;
          packages = sortedPackages;
        };
      }
      ''
        mkdir -p $out/${arch}
        ${lib.concatMapStringsSep "\n" (apkPackage: ''
          cp ${apkPackage}/${apkPackage.filename} $out/${arch}/${apkPackage.filename}
        '') sortedPackages}
        apk --allow-untrusted mkndx \
          --compression deflate:9 \
          --description ${lib.escapeShellArg description} \
          ${
            lib.optionalString (signingKey != null) ''
              --sign-key ${lib.escapeShellArg (toString signingKey)} \
            ''
          } \
          --output $out/${arch}/Packages.adb \
          $out/${arch}/*.apk
      '';
in
{
  inherit mkRepository;
}
