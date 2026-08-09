{ pkgs }:

# A small, empty filesystem seed for the persistent machine. The browser
# writes it to /root.ext4 in OPFS once; from then on that file is the disk.
pkgs.runCommand "site-install-disk.ext4"
  {
    nativeBuildInputs = [ pkgs.e2fsprogs ];
  }
  ''
    truncate -s 64M $out
    mke2fs -q -t ext4 -F -L rootfs -m 0 $out
  ''
