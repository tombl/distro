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
  # algorithms are left out; uncompressed output needs no library. The
  # workqueue is single-threaded here, libuuid is replaced by erofs-utils'
  # built-in UUID code, and FUSE (erofsfuse) has no library in the scope.
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

    # Mounts compressed images in the guest kernel and compares them with an
    # uncompressed one. The guest erofs-utils has no LZ4 compressor, so the
    # host's builds them. Big physical clusters decompress to several pages,
    # and 256 KiB ones also span several pages of compressed data even with
    # 64 KiB pages; both take LZ4 off its single-page path, which needs
    # vmap() with an MMU and contiguous buffers without one.
    compressed-mount = vm-test.installedTest {
      name = "erofs-utils-compressed-mount";
      init = ./compressed-mount-test.sh;
      contents = [ busybox ];
      # One global decompression buffer per CPU.
      cpus = 2;
      disks =
        let
          images =
            pkgs.runCommand "erofs-utils-compressed-images"
              {
                nativeBuildInputs = [ pkgs.erofs-utils ];
              }
              ''
                mkdir -p tree/nested $out
                seq 1 500000 >tree/numbers
                # Long runs decompress to megabytes from one physical cluster.
                head -c 16777216 /dev/zero >tree/zeros
                # Incompressible data is kept in uncompressed extents.
                LC_ALL=C awk 'BEGIN {
                  srand(1)
                  for (i = 0; i < 262144; i++) printf "%c", int(rand() * 256)
                }' >tree/random
                printf 'hello\n' >tree/nested/hello
                : >tree/empty
                ln -s nested/hello tree/link

                build() {
                  mkfs.erofs "$@" --all-root -T0 -U clear -x-1 tree
                }
                build $out/plain.img
                build -zlz4 $out/lz4.img
                build -zlz4 -C262144 $out/lz4-pcluster.img
                build -zlz4hc,12 -C65536 -Eztailpacking $out/lz4hc-tailpacking.img
                build -zdeflate,level=9 -C65536 -Eztailpacking $out/deflate.img
                build -zlzma -C65536 $out/lzma.img
              '';
        in
        # The order the guest script expects, starting at /dev/vdb.
        map (name: "${images}/${name}.img") [
          "plain"
          "lz4"
          "lz4hc-tailpacking"
          "deflate"
          "lzma"
          "lz4-pcluster"
        ];
    };
  };
})
