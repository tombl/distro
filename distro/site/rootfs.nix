# The site's guest rootfs: a writable ext4 image with busybox and apk-tools
# installed from the site's own repository. The boot script seeds it from the
# server into OPFS, so `apk add` inside the guest persists across reloads.
{
  apk,
  apk-tools,
  busybox,
  guest-agent,
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
      guest-agent
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
  format = "ext4";
  size = "64M";
}
