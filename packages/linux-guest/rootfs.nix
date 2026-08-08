{
  apk,
  busybox,
  guest-agent,
  image,
  pkgs,
  repository,
}:

image.mkFilesystem {
  name = "guest-rootfs";
  root = apk.mkSystem {
    name = "guest";
    repositories = [ repository ];
    packages = [
      busybox
      guest-agent
    ];
    files."/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
      nameserver 192.0.2.1
    '';
    files."/init" = {
      source = ./init.sh;
      mode = "0755";
    };
    files."/bin/linux-guest-agent" = "${guest-agent}/bin/linux-guest-agent";
  };
}
