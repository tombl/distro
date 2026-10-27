{
  busybox,
  mkImage,
  pkgs,
  format ? "erofs",
  size ? "256M",
}:

mkImage {
  name = "guest-rootfs";
  inherit format size;
  packages = [ busybox ];
  files."/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
    nameserver 192.0.2.1
  '';
}
