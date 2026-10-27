# The canonical system image that lowland/image attaches: the minimum userspace
# that can install everything else from the public repository.
{
  apk-tools,
  busybox,
  ca-certificates,
  mkImage,
  pkgs,
  format ? "erofs",
  size ? "256M",
}:

mkImage {
  name = "lowland-image-rootfs";
  inherit format size;
  compression = "deflate";
  packages = [
    busybox
    apk-tools
    ca-certificates
  ];
  files = {
    "/etc/apk/keys/site.rsa.pub" = ../../site/keys/site.rsa.pub;
    "/etc/apk/repositories" = pkgs.writeText "apk-repositories" ''
      http://assets.low.land/apk/wasm32/Packages.adb
    '';
  };
  # The kernel writes the nameserver from ip= there.
  links."/etc/resolv.conf" = "../proc/net/pnp";
}
