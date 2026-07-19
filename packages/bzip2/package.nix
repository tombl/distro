{
  stdenv,
  src,
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "bzip2";
  version = "1.0.8";
  inherit src;

  # The stock Makefile hardcodes the build toolchain and, in its default `all`
  # target, runs the freshly built bzip2 over sample files, which cannot
  # execute when cross-compiling to wasm. Override the tools and build only the
  # binaries; the `test` target is left out of buildFlags for that reason.
  makeFlags = [
    "CC=${stdenv.cc.targetPrefix}cc"
    "AR=llvm-ar"
    "RANLIB=llvm-ranlib"
    "PREFIX=${placeholder "out"}"
  ];

  buildFlags = [
    "bzip2"
    "bzip2recover"
  ];

  passthru.checks = {
    roundtrip = vm-test.vmTest {
      name = "bzip2-roundtrip";
      initramfs = vm-test.mkInitramfs {
        name = "bzip2-roundtrip";
        init = ./roundtrip-test.sh;
        contents = [
          finalAttrs.finalPackage
          busybox
        ];
      };
    };
  };
})
