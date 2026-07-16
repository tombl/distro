{
  busybox,
  vm-test,
}:

vm-test.mkInitramfs {
  name = "linux-guest-initramfs";
  init = ./init.sh;
  contents = [ busybox ];
}
