{
  busybox,
  mkInitramfs,
}:

mkInitramfs {
  name = "boot-initramfs";
  init = ./boot-init.sh;
  contents = [ busybox ];
}
