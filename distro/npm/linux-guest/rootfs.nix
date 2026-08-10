{
  apk,
  busybox,
  image,
  pkgs,
  repository,
  label ? "LOWLAND_ROOT",
  format ? "erofs",
  size ? "256M",
}:

image.mkFilesystem {
  name = "guest-rootfs";
  inherit format label size;
  root = apk.mkSystem {
    name = "guest";
    repositories = [ repository ];
    packages = [ busybox ];
    files."/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
      nameserver 192.0.2.1
    '';
  };
}
