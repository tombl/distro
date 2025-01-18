{
  run,
  basic-init,
}:

run { name = "initramfs.cpio"; } ''
  mkdir root
  cp ${basic-init}/bin/init root/init

  cd root
  find . | cpio -H newc -o > $out
''
