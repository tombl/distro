{
  stdenv,
  src,
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "patch";
  version = "2.7.6";
  inherit src;

  configureFlags = [
    "--disable-nls"
  ];

  # No wasm source changes needed: patch applies diffs with plain file I/O, and
  # its only child-spawn path (running an `ed` script, via systemic() ->
  # system()) goes through musl's system(), which is built on posix_spawn.

  passthru.checks = {
    functionality = vm-test.vmTest {
      name = "patch-functionality";
      initramfs = vm-test.mkInitramfs {
        name = "patch-functionality";
        init = ./functionality-test.sh;
        # busybox first, patch last: the GNU binary must shadow busybox's applet.
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
