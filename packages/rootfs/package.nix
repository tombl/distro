{
  pkgs,
  basic-init,
  busybox,
  vm-test,
}:

let
  package =
    pkgs.runCommand "rootfs.ext4"
      {
        nativeBuildInputs = [ pkgs.e2fsprogs ];
      }
      ''
        mkdir -p root/bin root/dev root/proc root/sys
        cp ${basic-init}/bin/init root/bin/basic-init
        cp -RP ${busybox}/. root/

        truncate -s 64M $out
        mke2fs -q -t ext4 -d root -F -L rootfs -m 0 $out
      '';
in
package
// {
  checks.mount = vm-test.vmTest {
    name = "rootfs-mount";
    initramfs = vm-test.mkInitramfs {
      name = "rootfs-mount";
      init = ./smoke-test.sh;
      contents = [ busybox ];
    };
    disk = package;
  };
}
