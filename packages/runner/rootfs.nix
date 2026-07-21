{
  basic-init,
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
  sed,
  sqlite3,
  tar,
  util-linux,
  vim,
  xz,
  zstd,
  vm-test,
}:

let
  # busybox is the base layer; everything after it shadows the matching
  # busybox applet (image.mkRootfs applies contents in order, later wins). This is
  # the `nix run` terminal system, so it carries the whole ported userland.
  package = image.mkRootfs {
    name = "runner-rootfs";
    init = ./rootfs-init.sh;
    contents = [
      busybox
      # GNU/BSD userland, shadowing busybox where they overlap.
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
      # interpreters and data tools
      jq
      lua
      quickjs
      python
      sqlite3
      # compression
      xz
      zstd
      bzip2
      # networking / crypto / VCS
      openssl
      curl
      git
      dropbear
      # editor and extra system tools
      vim
      util-linux
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
