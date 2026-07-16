{
  basic-init,
  busybox,
  mkRootfs,
  vm-test,
}:

let
  package = mkRootfs {
    name = "rootfs";
    init = ./init.sh;
    contents = [ busybox ];
    files."/bin/basic-init" = "${basic-init}/bin/init";
  };
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
