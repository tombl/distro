{
  pkgs,
  lib,
}:

{
  name,
  root,
  format ? "squashfs",
  size ? "256M",
}:

assert lib.assertMsg (builtins.isAttrs root && (root.isApkSystem or false)) "mkFilesystem root must be an apk.mkSystem result";
assert lib.assertMsg (builtins.elem format [
  "ext4"
  "squashfs"
]) "mkFilesystem format must be ext4 or squashfs, got ${format}";
pkgs.runCommand "${name}.${format}"
  {
    nativeBuildInputs = [
      pkgs.fakeroot
    ]
    ++ lib.optionals (format == "ext4") [ pkgs.e2fsprogs ]
    ++ lib.optionals (format == "squashfs") [ pkgs.squashfsTools ];
    passthru = {
      inherit format root;
    };
  }
  ''
    mkdir root
    cp -a --no-preserve=ownership ${root}/. root/
    chmod -R u+w root
    mkdir -p root/dev root/proc root/run root/sys root/tmp root/workspace
    chmod 01777 root/tmp

    ${
      if format == "ext4" then
        ''
          truncate -s ${lib.escapeShellArg (toString size)} "$out"
          fakeroot mke2fs -q -t ext4 -d root -F -L rootfs -m 0 "$out"
        ''
      else
        ''
          fakeroot mksquashfs root "$out" -noappend -all-root -no-xattrs \
            -no-progress -processors 1
        ''
    }
  ''
