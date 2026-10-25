{
  pkgs,
  lib,
  tools,
  platform,
  package,
}:

let
  # Content-addressed package file names. Published APKs are written once and
  # served as immutable; only Packages.adb changes between releases, and it
  # carries this spec so apk derives each package's URL from the index.
  hashLength = 16;
  pkgnameSpec = "\${name}-\${version}.\${hash:${toString hashLength}}.apk";

  mkRepository =
    {
      name,
      packages,
      arch ? platform.apkArch,
      description ? name,
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
          inherit arch name pkgnameSpec;
          packageSet = packages;
          packages = sortedPackages;
        };
      }
      ''
        mkdir -p staging $out/${arch}
        ${lib.concatMapStringsSep "\n" (apkPackage: ''
          cp ${apkPackage}/${apkPackage.filename} staging/${apkPackage.filename}
        '') sortedPackages}
        # A package's file name carries its v3 identity, the digest of its
        # metadata block (which holds every payload file's digest), so changed
        # bytes always get a new URL. The first index exists only to compute
        # those identities.
        apk --allow-untrusted mkndx --output identities.adb staging/*.apk
        apk adbdump identities.adb | awk '
          $1 == "-" && $2 == "name:" { name = $3 }
          $1 == "version:" { version = $2 }
          $1 == "hashes:" { print name, version, substr($2, 1, ${toString hashLength}) }
        ' | while read -r name version hash; do
          mv "staging/$name-$version.apk" "$out/${arch}/$name-$version.$hash.apk"
        done
        rmdir staging
        # mkndx resolves --pkgname-spec against index field names, where the
        # identity is "hashes" rather than apk's ''${hash}, so it warns that every
        # file mismatches the spec. The warning is harmless: install-time apk
        # substitutes ''${hash} from each package's identity.
        apk --allow-untrusted mkndx \
          --compression deflate:9 \
          --description ${lib.escapeShellArg description} \
          --pkgname-spec ${lib.escapeShellArg pkgnameSpec} \
          --output $out/${arch}/Packages.adb \
          $out/${arch}/*.apk
      '';
in
{
  inherit mkRepository;
}
