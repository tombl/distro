{
  basic-init,
  busybox,
  curl,
  dropbear,
  file,
  git,
  jq,
  lua,
  make,
  image,
  openssl,
  python,
  quickjs,
  sqlite3,
  zstd,
  vm-test,
}:

let
  package = image.mkRootfs {
    name = "runner-rootfs";
    init = ./rootfs-init.sh;
    contents = [
      busybox
      zstd
      file
      jq
      lua
      make
      openssl
      quickjs
      python
      sqlite3
      curl
      git
      dropbear
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
