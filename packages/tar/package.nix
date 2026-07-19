{
  stdenv,
  src,
  busybox,
  vm-test,
  xz,
  zstd,
  bzip2,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "tar";
  version = "1.35";
  inherit src;

  configureFlags = [
    "--disable-nls"
  ];

  # tar creates every child with fork()+exec (xfork/xexec in src/system.c, and
  # the remote-shell path in lib/rtapelib.c). wasm has no fork(); rewrite each
  # site to posix_spawn (clone+execve), carrying the between-fork-and-exec fd
  # plumbing in posix_spawn file actions and setting the child's environment in
  # the parent beforehand (posix_spawn cannot run code between clone and exec).
  # The compressor spawn used by -z/-j/-J/--zstd is the important path. Its old
  # regular-file branch (compressor writes straight to the archive fd) maps
  # cleanly to posix_spawn; the grandchild "reblocking" branch, used only for
  # pipe/stdin/non-regular/remote archives, is fork-for-concurrency (a tar
  # process shuffling records, not an exec) and cannot be expressed with
  # posix_spawn, so it now fails with a clear diagnostic. Compressing to and
  # from named regular files -- what the tests and normal use do -- works.
  patches = [ ./wasm-posix-spawn.patch ];

  passthru.checks = {
    functionality = vm-test.vmTest {
      name = "tar-functionality";
      initramfs = vm-test.mkInitramfs {
        name = "tar-functionality";
        init = ./functionality-test.sh;
        # busybox first, tar last: the GNU binary must shadow busybox's applet.
        # xz/zstd/bzip2 provide the compressors tar spawns for -J/--zstd/-j.
        contents = [
          busybox
          xz
          zstd
          bzip2
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
