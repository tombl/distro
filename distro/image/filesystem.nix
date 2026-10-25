# mkImage's encoder: turns an installed apk.mkSystem tree into the image file.
# Private to mkImage; arguments are validated and documented there.
{
  pkgs,
  lib,
}:

{
  name,
  root,
  format,
  compression,
  label,
  size,
  passthru ? { },
}:

assert lib.assertMsg (
  builtins.isAttrs root && (root.isApkSystem or false)
) "image root must be an apk.mkSystem result";
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
  builtins.isString label
  && builtins.stringLength label <= 15
  && builtins.match "[A-Za-z0-9._-]+" label != null
) "mkImage label must contain 1 to 15 ASCII letters, digits, dots, underscores, or hyphens";
let
  # 64 KiB physical clusters with tail packing; mkfs.erofs's own defaults
  # compress far worse. No lz4: the NOMMU kernel BUG()s mapping its buffers.
  compressionFlags =
    {
      deflate = "-zdeflate,level=9 -C65536 -Eztailpacking";
      lzma = "-zlzma -C65536 -Eztailpacking";
      none = "";
    }
    .${compression};
in
pkgs.runCommand "${name}.${format}"
  {
    nativeBuildInputs = [
      pkgs.fakeroot
    ]
    ++ lib.optionals (format == "ext4") [ pkgs.e2fsprogs ]
    ++ lib.optionals (format == "erofs") [ pkgs.erofs-utils ];
    passthru = passthru // {
      inherit format label;
    };
  }
  ''
    mkdir root
    cp -a --no-preserve=ownership ${root}/. root/
    chmod -R u+w root
    # The standard FHS dirs. /root in particular is the root user's home:
    # programs that chdir to it before exec (busybox crond's job children)
    # fail without it.
    mkdir -p root/dev root/mnt root/proc root/root root/run root/sys root/tmp
    chmod 01777 root/tmp

    ${
      if format == "ext4" then
        ''
          truncate -s ${lib.escapeShellArg (toString size)} "$out"
          # Chown and encode inside one fakeroot session so the recorded root
          # ownership survives into the image, matching how Alpine's own image
          # tooling drives apk.
          fakeroot sh -c 'chown -R 0:0 root && exec mke2fs -q -t ext4 -d root -F -L "$1" -m 0 "$0"' "$out" ${lib.escapeShellArg label}
        ''
      else
        ''
          fakeroot sh -c 'chown -R 0:0 root && exec mkfs.erofs --all-root --all-time \
            -T 0 -U 00000000-0000-0000-0000-000000000000 -L "$1" -x-1 ${compressionFlags} "$0" root' \
            "$out" ${lib.escapeShellArg label}
        ''
    }
  ''
