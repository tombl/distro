{
  stdenv,
  src,
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "sed";
  version = "4.9";
  inherit src;

  configureFlags = [
    "--disable-nls"
  ];

  # SUBDIRS is "po . gnulib-tests": the sed binary and its bundled gnulib lib
  # build in ".". The gnulib-tests tree includes vma-iter.c, which calls
  # mmap/munmap unconditionally to walk /proc/self/maps; wasm musl has no
  # <sys/mman.h> declarations, so it fails to compile. Restrict to "." to skip
  # both that test tree and the (disabled) NLS po catalogs.
  makeFlags = [ "SUBDIRS=." ];

  passthru.checks = {
    functionality = vm-test.vmTest {
      name = "sed-functionality";
      initramfs = vm-test.mkInitramfs {
        name = "sed-functionality";
        init = ./functionality-test.sh;
        # busybox first, sed last: the GNU binary must shadow busybox's applet.
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
