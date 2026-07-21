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
  throw "mkRootfs file paths must be absolute and normalized: ${lib.concatStringsSep ", " invalidFilePaths}"
else if builtins.hasAttr "/init" files then
  throw "mkRootfs files cannot define /init; use the init argument"
else
  pkgs.runCommand "${name}.squashfs"
    {
      nativeBuildInputs = [
        pkgs.fakeroot
        pkgs.findutils
        pkgs.squashfsTools
      ];
      rootfsSources = contents ++ builtins.attrValues normalizedFiles ++ [ normalizedInit ];
    }
    ''
      copy_tree() {
        local source=$1
        if [ ! -d "$source" ] || [ -L "$source" ]; then
          echo "mkRootfs: content must be a directory, got $source" >&2
          exit 1
        fi
        # --remove-destination so a later content replaces an earlier one's
        # entry outright: this is how a GNU tool shadows the matching busybox
        # applet (contents apply in list order, later wins). -RP keeps source
        # symlinks as symlinks and, combined with --remove-destination, replaces
        # rather than writing *through* an existing symlink -- otherwise a GNU
        # binary copied over busybox's applet symlink (e.g. bin/sed -> busybox)
        # would clobber the busybox binary itself instead of shadowing it. This
        # mirrors the initramfs builder's merge semantics.
        cp -RP --remove-destination -- "$source/." root/
        chmod -R u+w root
      }

      copy_file() {
        local source=$1
        local relative=$2
        local destination="root/$relative"
        if [ ! -f "$source" ] || [ -L "$source" ]; then
          echo "mkRootfs: /$relative must come from a regular file, got $source" >&2
          exit 1
        fi
        mkdir -p -- "$(dirname -- "$destination")"
        cp -a --update=none-fail -- "$source" "$destination"
      }

      mkdir root
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

      mkdir -p root/dev root/proc root/run root/sys root/tmp root/workspace
      chmod 01777 root/tmp

      fakeroot mksquashfs root "$out" -noappend -all-root -no-xattrs \
        -no-progress -processors 1
    ''
