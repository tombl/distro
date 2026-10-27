{
  busybox,
  mkImage,
  format ? "erofs",
  size ? "256M",
}:

mkImage {
  name = "guest-rootfs";
  inherit format size;
  packages = [ busybox ];
  links."/etc/resolv.conf" = "../proc/net/pnp";
}
