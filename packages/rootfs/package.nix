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
  mkRootfs,
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
  # busybox applet (mkRootfs applies contents in order, later wins). This is
  # the "nix run" terminal system, so it carries the whole ported userland --
  # size is not a concern here the way it is for the browser demo image.
  package = mkRootfs {
    name = "rootfs";
    init = ./init.sh;
    # The ext4 image is a sparse file; a generous cap just leaves headroom for
    # the full userland (python's stdlib and git's libexec dominate) plus the
    # filesystem's own overhead. It does not consume real disk until written.
    size = "512M";
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
    name = "rootfs-mount";
    initramfs = vm-test.mkInitramfs {
      name = "rootfs-mount";
      init = ./smoke-test.sh;
      contents = [ busybox ];
    };
    disk = package;
  };
}
