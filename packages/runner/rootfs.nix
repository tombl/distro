{
  basic-init,
  busybox,
  image,
  vm-test,
}:

let
  package = image.mkRootfs {
    name = "runner-rootfs";
    init = ./rootfs-init.sh;
    contents = [
      busybox
    ];
    files."/bin/basic-init" = "${basic-init}/bin/init";
  };
in
package
// {
  checks.mount = vm-test.vmTest {
    name = "runner-rootfs-mount";
    initramfs = vm-test.mkInitramfs {
      name = "runner-rootfs-mount";
      init = ./rootfs-smoke-test.sh;
      contents = [ busybox ];
    };
    disk = package;
  };
}
