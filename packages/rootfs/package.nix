{
  run,
  squashfsTools,
  wasmpkgs,
}:

run
  {
    name = "rootfs";
    path = [ squashfsTools ];
  }
  ''
    mkdir -p root/bin
    cp ${wasmpkgs.busybox}/bin/busybox root/bin/busybox
    ln -s bin/busybox root/init
    ln -s busybox root/bin/sh

    mksquashfs root $out
  ''
