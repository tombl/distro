# The builder image shipped for lowland/image/build. It is only booted by the
# build helper, which runs lowland-build-image inside it, so it contains just
# the tools that script uses. Rebuild it with
# `nix build .#lowland.builderImage` and copy the result to
# packages/lowland/assets/builder.erofs, or run `pnpm artifacts`.
{
  apk-tools,
  busybox,
  ca-certificates,
  e2fsprogs,
  erofs-utils,
  mkImage,
}:

mkImage {
  name = "lowland-image-builder";
  compression = "deflate";
  packages = [
    busybox
    apk-tools
    ca-certificates
    e2fsprogs
    erofs-utils
  ];
  files = {
    "/usr/sbin/lowland-build-image" = {
      source = ./build-image.sh;
      mode = "0755";
    };
    "/etc/apk/keys/site.rsa.pub" = ../../site/keys/site.rsa.pub;
  };
  links."/etc/resolv.conf" = "../proc/net/pnp";
}
