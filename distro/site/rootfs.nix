# The site's opinionated immutable system image. The guest package supplies the
# hidden agent disk; this image contains only the system userspace.
{
  apk,
  apk-tools,
  busybox,
  image,
  pkgs,
  repository,
}:

let
  system = apk.mkSystem {
    name = "site-rootfs";
    repositories = [ repository ];
    packages = [
      busybox
      apk-tools
    ];
    files = {
      "/init" = {
        source = ./init.sh;
        mode = "0755";
      };
      "/etc/apk/keys/site.rsa.pub" = repository.publicKey;
      "/etc/apk/repositories" = pkgs.writeText "site-apk-repositories" ''
        http://assets.low.land/apk/wasm32/Packages.adb
      '';
      "/etc/resolv.conf" = pkgs.writeText "site-resolv.conf" ''
        nameserver 192.0.2.1
      '';
    };
  };
in
image.mkFilesystem {
  name = "site-rootfs";
  root = system;
}
