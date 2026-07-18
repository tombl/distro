{
  busybox,
  guest-agent,
  mkRootfs,
  pkgs,
  sqlite3,
}:

# The image behind the site's live demos: the guest agent as init, so the
# page can exec/read/write against the machine, plus a userspace worth
# exploring from the terminal.
mkRootfs {
  name = "site-rootfs";
  init = "${guest-agent}/bin/linux-guest-agent";
  contents = [
    busybox
    sqlite3
  ];
  files."/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
    nameserver 192.0.2.1
  '';
  format = "squashfs";
}
