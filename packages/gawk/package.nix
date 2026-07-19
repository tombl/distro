{
  stdenv,
  src,
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "gawk";
  version = "5.3.1";
  inherit src;

  configureFlags = [
    "--disable-nls"
    # No dynamic loading on wasm (no dlopen), so gawk's C extension API is off.
    "--disable-extensions"
  ];

  # gawk creates every child with fork()+execl(): the system() builtin and the
  # pipe/coprocess redirections in io.c. wasm has no fork(); rewrite each site to
  # posix_spawn (clone+execve), carrying the between-fork-and-exec fd plumbing in
  # posix_spawn file actions. The pty-coprocess path needs setsid()/ioctl() that
  # posix_spawn cannot express, but it is unreachable on wasm (no /dev/ptmx), so
  # it is stubbed to fail and fall back to an ordinary pipe coprocess.
  patches = [ ./wasm-posix-spawn.patch ];

  passthru.checks = {
    functionality = vm-test.vmTest {
      name = "gawk-functionality";
      initramfs = vm-test.mkInitramfs {
        name = "gawk-functionality";
        init = ./functionality-test.sh;
        # busybox first, gawk last: the GNU binary must shadow busybox's applet.
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
