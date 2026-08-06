{
  pkgs,
  lib,
  tools,
  platform,
  dependency,
}:

let
  packagesFrom =
    name: value:
    if builtins.isAttrs value && (value.isApk or false) then
      [ value ]
    else if builtins.isAttrs value && (value.guestPackage or false) then
      builtins.attrValues value.apks
    else
      throw "repository member ${name} is not an APK or guest package derivation";

  mkRepository =
    {
      name,
      packages,
      arch ? platform.apkArch,
      description ? name,
      includeDependencies ? false,
    }:
    let
      declaredPackages = lib.concatLists (lib.mapAttrsToList packagesFrom packages);
      closureNode = apkPackage: {
        key = "${apkPackage.arch}:${apkPackage.name}:${apkPackage.version}:${apkPackage.drvPath}";
        value = apkPackage;
      };
      packageList =
        if includeDependencies then
          map (node: node.value) (
            lib.genericClosure {
              startSet = map closureNode declaredPackages;
              operator =
                node: map closureNode (dependency.packageDependencies (node.value.depends ++ node.value.installIf));
            }
          )
        else
          declaredPackages;
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
          --output $out/${arch}/Packages.adb \
          $out/${arch}/*.apk
      '';
in
{
  inherit mkRepository packagesFrom;
}
