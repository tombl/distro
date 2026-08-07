{
  apk,
  busybox,
  guest-agent,
  image,
  pkgs,
  repositories,
}:

image.mkFilesystem {
  name = "guest-rootfs";
  root = apk.mkSystem {
    name = "guest";
    repositories = [ repositories.main ];
    packages = [
      busybox
      guest-agent
    ];
    files."/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
      nameserver 192.0.2.1
    '';
    # A real copy, not a link: the wasm kernel cannot exec (or even stat -x)
    # through a symlink to an executable.
    files."/init" = {
      source = "${guest-agent}/bin/linux-guest-agent";
      mode = "0755";
    };
  };
}
