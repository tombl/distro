{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-1.5.6.tar.gz";
    hash = "sha256-qcd92hQqVBjMT3hyntjcgk29o9wGQsg5Hg7HE5C0UNc=";
  },
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "zstd";
  version = "1.5.6";
  inherit src;
  apk = { };

  # Only the CLI is wanted, and building just `programs/zstd` links the library
  # sources straight into a static binary, sidestepping the shared-library
  # targets that `make install` would otherwise build for this no-shared-libs
  # platform. HAVE_PTHREAD=0 keeps this a single-threaded pass.
  makeFlags = [
    "-C"
    "programs"
    "CC=${stdenv.cc.targetPrefix}cc"
    "HAVE_PTHREAD=0"
    "zstd"
  ];

  patches = [ ./mmap.patch ];

  installPhase = ''
    runHook preInstall
    install -Dm755 programs/zstd $out/bin/zstd
    for alias in unzstd zstdcat; do
      ln -s zstd $out/bin/$alias
    done
    runHook postInstall
  '';

  passthru.checks = {
    roundtrip = vm-test.installedTest {
      name = "zstd-roundtrip";
      init = ./roundtrip-test.sh;
      contents = [
        finalAttrs.finalPackage
        busybox
      ];
    };
  };
})
