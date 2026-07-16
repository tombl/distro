{
  busybox,
  guest-agent,
  mkRootfs,
}:

mkRootfs {
  name = "linux-guest-rootfs";
  init = "${guest-agent}/bin/linux-guest-agent";
  contents = [ busybox ];
  format = "squashfs";
}
