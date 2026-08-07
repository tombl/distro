{ pkgs }:

{
  name,
  initramfs,
  rootfs,
}:

let
  rootfsFormat = rootfs.format or "squashfs";
in
(pkgs.linkFarm name {
  "initramfs.cpio" = initramfs;
  "rootfs.${rootfsFormat}" = rootfs;
})
// {
  inherit initramfs rootfs rootfsFormat;
  checks = rootfs.checks or { };
}
