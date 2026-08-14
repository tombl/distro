{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://ftp.gnu.org/gnu/tar/tar-1.35.tar.xz";
    hash = "sha256-HztPW54hxHySvdrzkpMHKyhayOsoLUfDMATshJ95rTI=";
  },
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

  # wasm has no fork(), but its callback clone creates a process with a private
  # copy of memory when CLONE_VM is omitted.  That snapshot requires a
  # single-threaded caller, which tar is.  Keep tar's child-side setup and
  # compressor reblocking topology intact by starting each child at an
  # explicit callback on a fresh stack.
  patches = [ ./wasm-process-clone.patch ];

  passthru.apk = {
    depends = [
      "busybox"
      "bzip2"
      "xz"
      "zstd"
    ];
    replaces = [ "busybox" ];
  };

  passthru.checks = {
    functionality = vm-test.installedTest {
      name = "tar-functionality";
      init = ./functionality-test.sh;
      contents = [
        busybox
        bzip2
        xz
        zstd
        finalAttrs.finalPackage
      ];
    };
  };
})
