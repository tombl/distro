{
  run,
  wasmpkgs,
}:

run { name = "initramfs.cpio"; } ''
  mkdir -p root/bin root/usr/bin root/sbin root/usr/sbin root/opt
  cp ${./init.sh} root/init
  cp ${wasmpkgs.busybox}/bin/busybox root/bin/busybox
  cp -r ${wasmpkgs.python} root/opt/python

  cd root
  find . | cpio -H newc -o > $out
''
