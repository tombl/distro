{
  run,
  linux,
  initramfs,
  rootfs,
}:

run
  {
    name = "site";
    src = linux.site;
  }
  ''
    mkdir $out
    cp -r ./* $out/
    ln -s ${initramfs} $out/initramfs.cpio
    ln -s ${rootfs} $out/rootfs.ext4
  ''
