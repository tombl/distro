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

  postInstall = ''
    # The fragment contract includes every non-base compressor tar spawns.
    # Copy only the three canonical executables: tar installs none of these
    # paths, so there are no replacements or ambiguous symlink collisions.
    install -m755 ${xz}/bin/xz $out/bin/xz
    install -m755 ${zstd}/bin/zstd $out/bin/zstd
    install -m755 ${bzip2}/bin/bzip2 $out/bin/bzip2
  '';

  passthru.checks = {
    functionality = vm-test.vmTest {
      name = "tar-functionality";
      initramfs = vm-test.mkInitramfs {
        name = "tar-functionality";
        init = ./functionality-test.sh;
        # busybox supplies the base shell and gzip; the tar fragment itself
        # must carry xz/zstd/bzip2 for -J/--zstd/-j.
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
