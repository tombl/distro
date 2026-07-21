{ pkgs }:

{
  name,
  initramfs,
  rootfs,
}:

(pkgs.linkFarm name {
  "initramfs.cpio" = initramfs;
  "rootfs.squashfs" = rootfs;
})
// {
  inherit initramfs rootfs;
  checks = rootfs.checks or { };
}
