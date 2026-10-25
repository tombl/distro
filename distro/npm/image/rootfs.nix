# The canonical system image shipped by @lowland/image: the minimum userspace
# that can install everything else from the public repository.
{
  apk-tools,
  busybox,
  ca-certificates,
  mkImage,
  pkgs,
}:

mkImage {
  name = "lowland-image-rootfs";
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
    "/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
      nameserver 192.0.2.1
    '';
  };
}
