{
  pkgs,
  busybox,
}:

pkgs.runCommand "initramfs.cpio"
  {
    nativeBuildInputs = [
      pkgs.cpio
      pkgs.findutils
    ];
  }
  ''
    mkdir -p root/bin root/usr/bin root/sbin root/usr/sbin
    cp ${./init.sh} root/init
    chmod +x root/init
    cp ${busybox}/bin/busybox root/bin/busybox

    cd root
    find . | cpio -H newc -o > $out
  ''
