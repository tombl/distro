{
  run,
  busybox,
}:

run { name = "initramfs.cpio"; } ''
  mkdir -p root/bin
  cp ${busybox}/bin/busybox root/bin/sh
  ln -s ./bin/sh root/init

  cd root
  find . | cpio -H newc -o > $out
''
