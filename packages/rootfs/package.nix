{
  run,
  e2fsprogs,
  wasmpkgs,
  basic-init,
}:

run
  {
    name = "rootfs.ext4";
    path = [ e2fsprogs ];
  }
  ''
    mkdir -p root/bin root/dev root/proc root/sys
    cp ${basic-init}/bin/init root/bin/basic-init
    cp -RP ${wasmpkgs.busybox}/. root/

    truncate -s 64M $out
    mke2fs -q -t ext4 -d root -F -L rootfs -m 0 $out
  ''
