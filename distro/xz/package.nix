{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://github.com/tukaani-project/xz/releases/download/v5.6.4/xz-5.6.4.tar.gz";
    hash = "sha256-bJqZHrWqv1gankOKrnXakOVeVGgqPtw5Nn+kfTMKalQ=";
  },
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "xz";
  version = "5.6.4";
  inherit src;
  passthru.apk.replaces = [ "busybox" ];

  # Static-only target; NLS pulls in gettext, the sandbox methods (Capsicum,
  # Landlock, pledge) need syscalls the wasm kernel lacks, and the POSIX
  # threading pool is not needed for a single-threaded pass. The shell script
  # wrappers (xzgrep and friends) are dropped: nothing here consumes them.
  configureFlags = [
    "--disable-shared"
    "--disable-nls"
    "--disable-threads"
    "--disable-sandbox"
    "--disable-doc"
    "--disable-scripts"
  ];

  patches = [ ./wasm-sigmask.patch ];

  passthru.checks = {
    roundtrip = vm-test.installedTest {
      name = "xz-roundtrip";
      init = ./roundtrip-test.sh;
      contents = [
        finalAttrs.finalPackage
        busybox
      ];
    };
  };
})
