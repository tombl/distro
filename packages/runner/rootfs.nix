{
  apk,
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
  repository,
  sqlite3,
  vm-test,
  zstd,
}:

let
  package = image.mkFilesystem {
    name = "runner-rootfs";
    root = apk.mkSystem {
      name = "runner";
      repositories = [ repository ];
      packages = [
        basic-init
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
      files."/init" = {
        source = ./rootfs-init.sh;
        mode = "0755";
      };
      # A real copy, not a link: the wasm kernel cannot exec (or even stat -x)
      # through a symlink to an executable.
      files."/bin/basic-init" = "${basic-init}/bin/init";
    };
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
