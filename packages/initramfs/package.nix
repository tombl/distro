{
  run,
  wasmpkgs,
}:

run { name = "initramfs.cpio"; } ''
  mkdir -p root/bin root/usr/bin root/sbin root/usr/sbin
  cp ${./init.sh} root/init
  cp ${wasmpkgs.busybox}/bin/busybox root/bin/busybox

  cd root
  find . | cpio -H newc -o > $out
''
