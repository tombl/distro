{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://ftp.gnu.org/gnu/make/make-4.4.1.tar.gz";
    hash = "sha256-+Cg7R8wougcWcFf6u5B3lVX6RRgMRYZ1CD+e21URP5A=";
  },
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "make";
  version = "4.4.1";
  inherit src;
  passthru.apk.replaces = [ "busybox" ];

  # make runs every recipe through a child process. On wasm there is no
  # fork()/vfork(), only posix_spawn (clone+execve); make already has a full
  # posix_spawn job path (src/job.c, USE_POSIX_SPAWN) used on macOS. configure
  # defines USE_POSIX_SPAWN unless one of user/support/synchronous is exactly
  # "no": header spawn.h and func posix_spawn both detect against musl, and the
  # synchronous-failure probe is a run test that yields "no (cross-compiling)"
  # -- which is not the literal "no" the gate rejects -- so the spawn path is
  # selected without a patch. make_cv_synchronous_posix_spawn=yes states the
  # truth for musl (posix_spawn reports exec failure synchronously through its
  # internal errno pipe) and pins the answer deterministically instead of
  # leaning on the cross-compile default string.
  configureFlags = [
    "--disable-nls"
    "--without-guile"
    # make's 'load' directive dlopen()s a shared object at runtime. wasm has no
    # dlopen (musl links a stub that always fails), but configure detects the
    # link-only symbol and enables MAKE_LOAD, which then adds a pointless
    # -Wl,--export-dynamic to the final link. Disabling load drops both the dead
    # feature and that flag; there is no shared-object loading on this platform.
    "--disable-load"
    "make_cv_synchronous_posix_spawn=yes"
  ];

  passthru.checks = {
    functionality = vm-test.installedTest {
      name = "make-functionality";
      init = ./functionality-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  };
})
