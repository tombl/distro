{
  busybox,
  mkImage,
  pkgs,
  label ? "LOWLAND_ROOT",
  format ? "erofs",
  size ? "256M",
}:

mkImage {
  name = "guest-rootfs";
  inherit format label size;
  packages = [ busybox ];
  files."/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
    nameserver 192.0.2.1
  '';
}
