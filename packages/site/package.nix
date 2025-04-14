{
  run,
  linux,
  initramfs,
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
  ''
