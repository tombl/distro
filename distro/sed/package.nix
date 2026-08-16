{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "mirror://gnu/sed/sed-4.9.tar.xz";
    hash = "sha256-yQTI0WzgSOolziBUNU9ayhASUT2/xFi3jt1C2z1MFZw=";
  },
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

  passthru.apk.replaces = [ "busybox" ];

  passthru.checks = {
    functionality = vm-test.installedTest {
      name = "sed-functionality";
      init = ./functionality-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  };
})
