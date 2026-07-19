{
  stdenv,
  src,
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "findutils";
  version = "4.10.0";
  inherit src;

  configureFlags = [
    "--disable-nls"
  ];

  # find's -exec/-execdir/-ok create the child with fork()+execvp(). wasm has no
  # fork(); rewrite launch() to posix_spawnp (clone+execve), carrying the
  # between-fork-and-exec work -- the /dev/null stdin redirect and the chdir into
  # wd_for_exec that prep_child_for_exec() did -- as posix_spawn file actions.
  # xargs already routes through gnulib's spawn (posix_spawnp), so it needs no
  # patch.
  patches = [ ./wasm-posix-spawn.patch ];

  passthru.checks = {
    functionality = vm-test.vmTest {
      name = "findutils-functionality";
      initramfs = vm-test.mkInitramfs {
        name = "findutils-functionality";
        init = ./functionality-test.sh;
        # busybox first, findutils last: the GNU binary must shadow busybox's applet.
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
