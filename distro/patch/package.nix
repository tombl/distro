{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://ftp.gnu.org/gnu/patch/patch-2.7.6.tar.xz";
    hash = "sha256-Ng14vbD6V0ixnoeOxERqCxIuY2JWMaCeHykoGHAHPvo=";
  },
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

  passthru.apk.replaces = [ "busybox" ];

  passthru.checks = {
    functionality = vm-test.installedTest {
      name = "patch-functionality";
      init = ./functionality-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  };
})
