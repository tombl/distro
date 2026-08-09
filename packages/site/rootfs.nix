# The site's live guest rootfs: an immutable SquashFS with busybox and
# apk-tools installed from the site's own repository. /init adds a disposable
# tmpfs OverlayFS upper so the running live system is writable.
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
        source = ./live-init.sh;
        mode = "0755";
      };
      "/sbin/site-init" = {
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
  format = "squashfs";
}
