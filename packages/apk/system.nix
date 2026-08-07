{
  pkgs,
  lib,
  tools,
  platform,
  package,
}:

let
  normalizeSource =
    source:
    if builtins.typeOf source == "path" then
      builtins.path {
        path = source;
        name = builtins.baseNameOf source;
      }
    else
      source;

  normalizeFile =
    value:
    if builtins.isAttrs value && value ? source then
      {
        source = normalizeSource value.source;
        mode = value.mode or null;
      }
    else
      {
        source = normalizeSource value;
        mode = null;
      };

  validPath =
    path:
    lib.hasPrefix "/" path
    && path != "/"
    && lib.all (component: component != "" && component != "." && component != "..") (
      builtins.tail (lib.splitString "/" path)
    );

  mkSystem =
    {
      name,
      repositories,
      packages,
      allowUntrusted ? true,
      files ? { },
      links ? { },
    }:
    let
      apkPackages = map package.packageFrom packages;
      invalidRepositories = builtins.filter (
        repository: !(builtins.isAttrs repository && (repository.isApkRepository or false))
      ) repositories;
      repositoryArgs = lib.concatMapStringsSep " " (
        repository: "--repository ${lib.escapeShellArg "${repository}/${repository.arch}/Packages.adb"}"
      ) repositories;
      packageArgs = lib.concatMapStringsSep " " (
        apkPackage: lib.escapeShellArg "${apkPackage.name}=${apkPackage.version}"
      ) apkPackages;
      paths = builtins.attrNames files ++ builtins.attrNames links;
      invalidPaths = builtins.filter (path: !validPath path) paths;
      duplicatePaths = lib.intersectLists (builtins.attrNames files) (builtins.attrNames links);
      normalizedFiles = builtins.mapAttrs (_path: normalizeFile) files;
      invalidModes = builtins.filter (
        path:
        let
          mode = normalizedFiles.${path}.mode;
        in
        mode != null && (!builtins.isString mode || builtins.match "0?[0-7]{3,4}" mode == null)
      ) (builtins.attrNames normalizedFiles);
    in
    assert lib.assertMsg (repositories != [ ]) "apk.mkSystem requires at least one repository";
    assert lib.assertMsg (invalidRepositories == [ ]) "apk.mkSystem received a non-APK repository";
    assert lib.assertMsg (apkPackages != [ ]) "apk.mkSystem requires at least one package";
    assert lib.assertMsg (
      invalidPaths == [ ]
    ) "APK system paths must be absolute and normalized: ${lib.concatStringsSep ", " invalidPaths}";
    assert lib.assertMsg (
      duplicatePaths == [ ]
    ) "APK system paths cannot be both files and links: ${lib.concatStringsSep ", " duplicatePaths}";
    assert lib.assertMsg (
      invalidModes == [ ]
    ) "APK system file modes must be octal strings: ${lib.concatStringsSep ", " invalidModes}";
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
          ${repositoryArgs} \
          add --initdb ${packageArgs}

        # Product configuration is layered on the installed packages after the
        # install; image encoding applies root ownership to the whole tree.
        ${lib.concatMapStringsSep "\n" (path: ''
          destination=$out/${lib.escapeShellArg (lib.removePrefix "/" path)}
          mkdir -p "$(dirname "$destination")"
          cp -a ${lib.escapeShellArg (toString normalizedFiles.${path}.source)} "$destination"
          ${lib.optionalString (normalizedFiles.${path}.mode != null) ''
            chmod ${lib.escapeShellArg normalizedFiles.${path}.mode} "$destination"
          ''}
        '') (builtins.attrNames normalizedFiles)}
        ${lib.concatMapStringsSep "\n" (path: ''
          destination=$out/${lib.escapeShellArg (lib.removePrefix "/" path)}
          mkdir -p "$(dirname "$destination")"
          ln -s ${lib.escapeShellArg links.${path}} "$destination"
        '') (builtins.attrNames links)}
      '';
in
{
  inherit mkSystem;
}
