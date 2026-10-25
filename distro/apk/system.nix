{
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
      repositories,
      packages,
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
    # The result is not a derivation but the shell that installs the system
    # into "$root". mkImage runs it in the same fakeroot session that encodes
    # the image: a store path would normalise every mode to 0444 or 0555, so
    # a requested mode such as 0600 or 4755 only survives if install and
    # encode share one build.
    {
      isApkSystem = true;
      inherit apkPackages repositories;
      nativeBuildInputs = [ tools ];
      install = ''
        mkdir -p "$root"
        # Build-time repositories are unsigned: signing happens only at
        # publication, outside Nix, so the key never enters the store.
        apk \
          --root "$root" \
          --arch ${platform.apkArch} \
          --allow-untrusted \
          ${repositoryArgs} \
          add --initdb ${packageArgs}

        # apk records the build command, including the temporary Nix repository
        # paths and a wall-clock timestamp. The log has no runtime purpose and
        # would otherwise make filesystem images impure and non-relocatable.
        rm "$root/var/log/apk.log"

        # Product configuration is layered on the installed packages after the
        # install; image encoding applies root ownership to the whole tree.
        # Sources come from the store without write permission, so copied
        # entries gain owner write: 0644, or 0755 when executable. A directory
        # onto an existing directory merges into it, where cp -a would nest it
        # under its store name, and the existing directory keeps its mode.
        # A requested mode applies to the destination itself, never to the
        # entries copied beneath it.
        place() {
          mkdir -p "$(dirname "$2")"
          if [ -d "$1" ] && [ -d "$2" ]; then
            existing=$(stat -c %a "$2")
            cp -a "$1/." "$2"
            chmod "$existing" "$2"
            (cd "$1" && find . -mindepth 1 ! -type l -print0) | (cd "$2" && xargs -0 -r chmod u+w)
          else
            cp -a "$1" "$2"
            chmod -R u+w "$2"
          fi
        }
        ${lib.concatMapStringsSep "\n" (path: ''
          destination="$root"/${lib.escapeShellArg (lib.removePrefix "/" path)}
          place ${lib.escapeShellArg (toString normalizedFiles.${path}.source)} "$destination"
          ${lib.optionalString (normalizedFiles.${path}.mode != null) ''
            chmod ${lib.escapeShellArg normalizedFiles.${path}.mode} "$destination"
          ''}
        '') (builtins.attrNames normalizedFiles)}
        ${lib.concatMapStringsSep "\n" (path: ''
          destination="$root"/${lib.escapeShellArg (lib.removePrefix "/" path)}
          mkdir -p "$(dirname "$destination")"
          ln -s ${lib.escapeShellArg links.${path}} "$destination"
        '') (builtins.attrNames links)}
      '';
    };
in
{
  inherit mkSystem;
}
