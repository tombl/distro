{
  pkgs,
  stdenv,
  src ? pkgs.fetchurl {
    url = "https://git.kernel.org/pub/scm/linux/kernel/git/xiang/erofs-utils.git/snapshot/erofs-utils-1.9.4.tar.gz";
    hash = "sha256-fRNaolUDJqWs8g9TxRiupaiQABXOUHAAROQPgYwx3YA=";
  },
  busybox,
  xz,
  zlib,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "erofs-utils";
  version = "1.9.4";
  inherit src;

  nativeBuildInputs = [
    pkgs.autoreconfHook
    pkgs.pkg-config
  ];
  buildInputs = [
    xz
    zlib
  ];

  patches = [ ./fragments-no-mmap.patch ];

  # mount.erofs exists to supervise NBD/FUSE/OCI backends, all of which fork
  # a daemon. Plain EROFS images mount through BusyBox or util-linux mount, so
  # drop it (and the stress-test contrib tool, which also forks) rather than
  # port helpers this guest cannot use.
  postPatch = ''
    substituteInPlace Makefile.am --replace-fail 'SUBDIRS += mount contrib' ""
  '';

  # -zdeflate uses erofs-utils' built-in encoder and -zlzma the scope's static
  # liblzma; zlib decompresses deflate images for fsck.erofs and dump.erofs.
  # lz4 is not packaged and the zstd port ships only its CLI, so those
  # algorithms are left out. The guest kernel reads deflate and lzma images;
  # it cannot read lz4 ones anyway. The workqueue is single-threaded
  # here, libuuid is replaced by erofs-utils' built-in UUID code, and FUSE
  # (erofsfuse) has no library in the scope.
  configureFlags = [
    "--enable-lzma"
    "--with-zlib"
    "--disable-multithreading"
    "--disable-fuse"
    "--without-uuid"
    "--without-selinux"
    "MAX_BLOCK_SIZE=4096"
  ];

  postInstall = ''
    rm "$out/share/man/man8/mount.erofs.8"*
  '';

  passthru.checks = {
    image = vm-test.installedTest {
      name = "erofs-utils-image";
      init = ./image-test.sh;
      contents = [
        finalAttrs.finalPackage
        busybox
      ];
      disks = [
        (pkgs.runCommand "erofs-utils-test-device" { } ''
          truncate -s 32M $out
        '')
      ];
    };
  };
})
