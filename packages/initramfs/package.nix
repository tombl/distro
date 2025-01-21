{
  run,
  busybox,
}:

run { name = "initramfs.cpio"; } ''
  mkdir -p root/bin
  cp ${busybox}/bin/busybox root/bin/sh

  echo '#!/bin/sh' > root/init
  echo 'exec /bin/sh' >> root/init
  chmod +x root/init

  cd root
  find . | cpio -H newc -o > $out
''
