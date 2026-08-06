{
  pkgs,
  lib,
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

  mkProfile =
    {
      name,
      version ? "0-r0",
      description ? name,
      license ? "MIT",
      depends,
      files ? { },
      links ? { },
    }:
    let
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
      payload = pkgs.runCommand "${name}-profile-root" { } ''
        mkdir -p $out
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
    assert lib.assertMsg (
      invalidPaths == [ ]
    ) "APK profile paths must be absolute and normalized: ${lib.concatStringsSep ", " invalidPaths}";
    assert lib.assertMsg (
      duplicatePaths == [ ]
    ) "APK profile paths cannot be both files and links: ${lib.concatStringsSep ", " duplicatePaths}";
    assert lib.assertMsg (
      invalidModes == [ ]
    ) "APK profile file modes must be octal strings: ${lib.concatStringsSep ", " invalidModes}";
    package.mkPackage {
      inherit
        depends
        description
        license
        name
        payload
        version
        ;
      arch = "noarch";
    };
in
{
  inherit mkProfile;
}
