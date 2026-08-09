{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz";
    hash = "sha256-Uvi4JZPPERK3gym4yoaeTEJwKXF5brBAEN7GgF+iF6g=";
  },
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "bzip2";
  version = "1.0.8";
  inherit src;
  passthru.apk.replaces = [ "busybox" ];

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

  # Upstream's monolithic install target also installs bzgrep, bzdiff, and
  # bzmore (plus their aliases). Those shell wrappers require tools which are
  # deliberately not part of this package, so install only the native
  # programs, library, header, and matching manual page.
  installPhase = ''
    runHook preInstall

    install -Dm755 bzip2 "$out/bin/bzip2"
    install -Dm755 bzip2recover "$out/bin/bzip2recover"
    ln -s bzip2 "$out/bin/bunzip2"
    ln -s bzip2 "$out/bin/bzcat"
    install -Dm644 libbz2.a "$out/lib/libbz2.a"
    install -Dm644 bzlib.h "$out/include/bzlib.h"
    install -Dm644 bzip2.1 "$out/man/man1/bzip2.1"

    runHook postInstall
  '';

  passthru.checks = {
    roundtrip = vm-test.installedTest {
      name = "bzip2-roundtrip";
      init = ./roundtrip-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  };
})
