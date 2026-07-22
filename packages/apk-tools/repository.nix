{
  pkgs,
  lib,
}:

let
  mkPackage =
    {
      package,
      name ? package.pname,
      version ? "${package.version}-r0",
      description ? package.meta.description or name,
      license ? "unknown",
      depends ? [ ],
      provides ? [ ],
      replaces ? [ ],
      scripts ? { },
    }:
    let
      filename = "${name}-${version}.apk";
      normalizedScripts = builtins.mapAttrs (
        _type: script:
        if builtins.typeOf script == "path" then
          builtins.path {
            path = script;
            name = builtins.baseNameOf script;
          }
        else
          script
      ) scripts;
      info = {
        inherit
          name
          version
          description
          license
          ;
        arch = "wasm32";
        origin = name;
      }
      // lib.optionalAttrs (depends != [ ]) { depends = lib.concatStringsSep " " depends; }
      // lib.optionalAttrs (provides != [ ]) { provides = lib.concatStringsSep " " provides; }
      // lib.optionalAttrs (replaces != [ ]) { replaces = lib.concatStringsSep " " replaces; };
      infoArgs = lib.concatMapStringsSep " " (
        field: "--info ${lib.escapeShellArg "${field}:${info.${field}}"}"
      ) (builtins.attrNames info);
      scriptArgs = lib.concatMapStringsSep " " (
        type: "--script ${lib.escapeShellArg "${type}:${toString normalizedScripts.${type}}"}"
      ) (builtins.attrNames normalizedScripts);
    in
    pkgs.runCommand "apk-package-${name}-${version}"
      {
        nativeBuildInputs = [ pkgs.apk-tools ];
        passthru = {
          inherit filename name version;
        };
      }
      ''
        mkdir $out
        apk mkpkg \
          --compression deflate:9 \
          --files ${package} \
          ${infoArgs} ${scriptArgs} \
          --output "$out/${filename}"
      '';

  mkRepository =
    {
      name,
      packages,
    }:
    pkgs.runCommand "${name}-apk-repository"
      {
        nativeBuildInputs = [ pkgs.apk-tools ];
      }
      ''
        mkdir -p $out/wasm32
        ${lib.concatMapStringsSep "\n" (package: ''
          cp ${package}/${package.filename} $out/wasm32/${package.filename}
        '') packages}
        apk --allow-untrusted mkndx \
          --compression deflate:9 \
          --description ${lib.escapeShellArg name} \
          --output $out/wasm32/Packages.adb \
          $out/wasm32/*.apk
      '';
in
{
  inherit mkPackage mkRepository;
}
