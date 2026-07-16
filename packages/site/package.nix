{
  pkgs,
  initramfs,
  linux,
  rootfs,
}:

pkgs.runCommand "site" { } ''
  mkdir $out
  cp -r ${linux.site}/* $out/
  ln -s ${initramfs} $out/initramfs.cpio
  ln -s ${rootfs} $out/rootfs.ext4
''
