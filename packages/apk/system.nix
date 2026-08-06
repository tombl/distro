{
  pkgs,
  lib,
  tools,
  platform,
}:

let
  packageFrom =
    value:
    if builtins.isAttrs value && (value.isApk or false) then
      value
    else if builtins.isAttrs value && (value.guestPackage or false) then
      value.apk
    else
      throw "apk.mkSystem packages must be APKs or guest package derivations";

  mkSystem =
    {
      name,
      repositories,
      packages,
      allowUntrusted ? true,
      scripts ? false,
    }:
    let
      apkPackages = map packageFrom packages;
      invalidRepositories = builtins.filter (
        repository: !(builtins.isAttrs repository && (repository.isApkRepository or false))
      ) repositories;
      repositoryArgs = lib.concatMapStringsSep " " (
        repository: "--repository ${lib.escapeShellArg "${repository}/${repository.arch}/Packages.adb"}"
      ) repositories;
      packageArgs = lib.concatMapStringsSep " " (
        apkPackage: lib.escapeShellArg "${apkPackage.name}=${apkPackage.version}"
      ) apkPackages;
    in
    assert lib.assertMsg (repositories != [ ]) "apk.mkSystem requires at least one repository";
    assert lib.assertMsg (invalidRepositories == [ ]) "apk.mkSystem received a non-APK repository";
    assert lib.assertMsg (apkPackages != [ ]) "apk.mkSystem requires at least one package";
    pkgs.runCommand "${name}-apk-system"
      {
        nativeBuildInputs = [
          pkgs.fakeroot
          tools
        ];
        passthru = {
          isApkSystem = true;
          inherit apkPackages repositories;
        };
      }
      ''
        mkdir -p $out
        fakeroot apk \
          --root $out \
          --arch ${platform.apkArch} \
          ${lib.optionalString allowUntrusted "--allow-untrusted"} \
          ${lib.optionalString (!scripts) "--no-scripts"} \
          ${repositoryArgs} \
          add --initdb ${packageArgs}
      '';
in
{
  inherit mkSystem packageFrom;
}
