{
  apk,
  basic-init,
  bash,
  busybox,
  bzip2,
  coreutils,
  curl,
  diffutils,
  dropbear,
  file,
  findutils,
  gawk,
  git,
  grep,
  jq,
  less,
  lua,
  make,
  image,
  openssl,
  patch,
  python,
  quickjs,
  repository,
  sed,
  sqlite3,
  tar,
  util-linux,
  vim,
  xz,
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
        bash
        coreutils
        findutils
        diffutils
        patch
        tar
        sed
        grep
        gawk
        make
        less
        file
        jq
        lua
        quickjs
        python
        sqlite3
        xz
        zstd
        bzip2
        openssl
        curl
        git
        dropbear
        vim
        util-linux
      ];
      files."/init" = {
        source = ../../runner/rootfs-init.sh;
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
      init = ../../runner/rootfs-smoke-test.sh;
      contents = [ busybox ];
    };
    disk = package;
  };
}
