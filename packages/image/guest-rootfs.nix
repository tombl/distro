{
  busybox,
  guest-agent,
  mkRootfs,
  pkgs,
}:

{
  name,
  contents ? [ ],
  files ? { },
  format ? "squashfs",
  size ? "256M",
}:

mkRootfs {
  inherit name format size;
  init = "${guest-agent}/bin/linux-guest-agent";
  contents = [ busybox ] ++ contents;
  files = {
    "/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
      nameserver 192.0.2.1
    '';
  }
  // files;
}
