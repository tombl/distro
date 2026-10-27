# mkImage's builder: installs an apk.mkSystem into a tree and encodes it as
# the image file.
# Private to mkImage; arguments are validated and documented there.
{
  pkgs,
  lib,
}:

{
  name,
  system,
  format,
  compression,
  label,
  size,
  passthru ? { },
}:

assert lib.assertMsg (
  builtins.isAttrs system && (system.isApkSystem or false)
) "image system must be an apk.mkSystem result";
assert lib.assertMsg (builtins.elem format [
  "erofs"
  "ext4"
]) "mkImage format must be erofs or ext4, got ${format}";
assert lib.assertMsg (builtins.elem compression [
  "deflate"
  "lzma"
  "none"
]) "mkImage compression must be deflate, lzma, or none, got ${compression}";
assert lib.assertMsg (
  label == null
  || (
    builtins.isString label
    && builtins.stringLength label <= 15
    && builtins.match "[A-Za-z0-9._-]+" label != null
  )
) "mkImage label must contain 1 to 15 ASCII letters, digits, dots, underscores, or hyphens";
let
  labelFlags = lib.optionalString (label != null) "-L ${lib.escapeShellArg label}";
  # 64 KiB physical clusters with tail packing; mkfs.erofs's own defaults
  # compress far worse. No lz4: the NOMMU kernel BUG()s mapping its buffers.
  compressionFlags =
    {
      deflate = "-zdeflate,level=9 -C65536 -Eztailpacking";
      lzma = "-zlzma -C65536 -Eztailpacking";
      none = "";
    }
    .${compression};
  # One fakeroot session spans install and encode, so the encoder reads the
  # modes and ownership apk and `files` set rather than ones normalised by a
  # store path between the two, matching how Alpine's own image tooling
  # drives apk.
  script = pkgs.writeText "${name}-image.sh" ''
    root=$PWD/root
    ${system.install}

    # The standard FHS dirs. /root in particular is the root user's home:
    # programs that chdir to it before exec (busybox crond's job children)
    # fail without it.
    mkdir -p root/dev root/mnt root/proc root/root root/run root/sys root/tmp
    chmod 01777 root/tmp

    chown -R 0:0 root
    ${
      if format == "ext4" then
        ''
          truncate -s ${lib.escapeShellArg (toString size)} "$out"
          mke2fs -q -t ext4 -d root -F ${labelFlags} -m 0 "$out"
        ''
      else
        ''
          mkfs.erofs --all-root --all-time \
            -T 0 -U 00000000-0000-0000-0000-000000000000 ${labelFlags} -x-1 ${compressionFlags} "$out" root
        ''
    }
  '';
in
pkgs.runCommand "${name}.${format}"
  {
    nativeBuildInputs = [
      pkgs.fakeroot
    ]
    ++ system.nativeBuildInputs
    ++ lib.optionals (format == "ext4") [ pkgs.e2fsprogs ]
    ++ lib.optionals (format == "erofs") [ pkgs.erofs-utils ];
    passthru = passthru // {
      inherit format label;
    };
  }
  ''
    fakeroot bash -e ${script}
  ''
