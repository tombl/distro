{
  apk,
  busybox,
  image,
  pkgs,
  repository,
  label ? "LOWLAND_ROOT",
}:

image.mkFilesystem {
  name = "guest-rootfs";
  inherit label;
  root = apk.mkSystem {
    name = "guest";
    repositories = [ repository ];
    packages = [ busybox ];
    files."/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
      nameserver 192.0.2.1
    '';
  };
}
