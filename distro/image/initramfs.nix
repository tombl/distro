{
  pkgs,
  lib,
}:

{
  name,
  init,
  contents ? [ ],
  files ? { },
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
  normalizedFiles = builtins.mapAttrs (_path: normalizeSource) files;
  normalizedInit = normalizeSource init;
  filePaths = builtins.attrNames normalizedFiles;
  validFilePath =
    path:
    lib.hasPrefix "/" path
    && path != "/"
    && lib.all (component: component != "" && component != "." && component != "..") (
      builtins.tail (lib.splitString "/" path)
    );
  invalidFilePaths = builtins.filter (path: !validFilePath path) filePaths;
in

if invalidFilePaths != [ ] then
  throw "mkInitramfs file paths must be absolute and normalized: ${lib.concatStringsSep ", " invalidFilePaths}"
else if builtins.hasAttr "/init" files then
  throw "mkInitramfs files cannot define /init; use the init argument"
else
  pkgs.runCommand "${name}.cpio"
    {
      nativeBuildInputs = [
        pkgs.cpio
        pkgs.findutils
      ];
      initramfsSources = contents ++ builtins.attrValues normalizedFiles ++ [ normalizedInit ];
    }
    ''
      copy_tree() {
        local source=$1
        if [ ! -d "$source" ] || [ -L "$source" ]; then
          echo "mkInitramfs: content must be a directory, got $source" >&2
          exit 1
        fi
        cp -RP --remove-destination -- "$source/." root/
        chmod -R u+w root
      }

      copy_file() {
        local source=$1
        local relative=$2
        local destination="root/$relative"
        if [ ! -f "$source" ] || [ -L "$source" ]; then
          echo "mkInitramfs: /$relative must come from a regular file, got $source" >&2
          exit 1
        fi
        mkdir -p -- "$(dirname -- "$destination")"
        cp -a --update=none-fail -- "$source" "$destination"
      }

      mkdir -p root/dev root/proc root/sys root/tmp
      ${lib.concatMapStringsSep "\n" (
        content: "copy_tree ${lib.escapeShellArg (toString content)}"
      ) contents}
      ${lib.concatMapStringsSep "\n" (
        path:
        "copy_file ${
          lib.escapeShellArg (toString normalizedFiles.${path})
        } ${lib.escapeShellArg (lib.removePrefix "/" path)}"
      ) filePaths}
      copy_file ${lib.escapeShellArg (toString normalizedInit)} init
      chmod 0755 root/init

      cd root
      find . -print0 | sort -z | cpio --null --reproducible --owner=0:0 -H newc -o > $out
    ''
