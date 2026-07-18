{
  busybox,
  guest-agent,
  mkRootfs,
  pkgs,
}:

mkRootfs {
  name = "linux-guest-rootfs";
  init = "${guest-agent}/bin/linux-guest-agent";
  contents = [ busybox ];
  files."/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
    nameserver 192.0.2.1
  '';
  format = "squashfs";
}
