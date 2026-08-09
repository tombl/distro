{ pkgs }:

# The site relabels this disk LOWLAND_ROOT only for installed boot. During
# live boot it remains LOWLAND_INSTALL, so the general-purpose agent always
# sees exactly one system root.
pkgs.runCommand "site-install-disk.ext4"
  {
    nativeBuildInputs = [ pkgs.e2fsprogs ];
  }
  ''
    truncate -s 64M $out
    # The MVP site switches this disk between LOWLAND_INSTALL and LOWLAND_ROOT
    # by replacing ext4's fixed label field before the guest mounts it. Disable
    # metadata_csum so that operation does not require a filesystem-aware
    # superblock checksum implementation in the browser facade.
    mke2fs -q -t ext4 -F -O ^metadata_csum,^metadata_csum_seed \
      -L LOWLAND_INSTALL -m 0 $out
  ''
