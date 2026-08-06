{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://matt.ucc.asn.au/dropbear/releases/dropbear-2026.92.tar.bz2";
    hash = "sha256-xXjKWj6tMW/Qlq4DttxKAqOwsER2QEeb1Qw3Gllu2QQ=";
  },
  vm-test,
  busybox,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "dropbear";
  version = "2026.92";
  inherit src;
  apk = { };

  # wasm musl has no fork()/vfork() symbols. This patch uses posix_spawn for
  # command sessions and callback clone for PTY sessions, where the child must
  # setsid, acquire the slave as its controlling terminal, attach stdio, and
  # exec on a fresh stack. It also converts the shared spawn_command helper and
  # rejects the client's daemon()-based "-f" backgrounding. Every other fork()
  # site is compiled out via localoptions.h (see there).
  patches = [ ./wasm-posix-spawn.patch ];

  # localoptions.h must sit in the build root: Makefile.in adds -I. and
  # options.h does #include "localoptions.h", guarded by LOCALOPTIONS_H_EXISTS
  # which the Makefile defines when ./localoptions.h is present.
  postPatch = ''
    cp ${./localoptions.h} localoptions.h
  '';

  # Force HAVE_DAEMON so compat.c does NOT compile its own fork()-based
  # daemon() fallback (compat.o is always linked). The patch removes the only
  # real daemon() caller and NON_INETD_MODE is off, so nothing references
  # daemon(); we just need compat out of the way. The cross link-test for
  # daemon() fails on its own (it would pull in the missing fork), which would
  # otherwise leave HAVE_DAEMON unset and drag the fork()ing fallback back in.
  env.ac_cv_func_daemon = "yes";

  # No compression (optional; avoids a zlib link dep) and no PAM (default).
  # The utmp/wtmp/lastlog login records are pty-session bookkeeping we do not
  # reach, and the guest has no such databases.
  configureFlags = [
    "--disable-zlib"
    "--disable-pam"
    "--disable-lastlog"
    "--disable-wtmp"
    "--disable-utmp"
    "--disable-loginfunc"
  ];

  enableParallelBuilding = true;

  # Default PROGRAMS is "dropbear dbclient dropbearkey dropbearconvert" -- none
  # of which link scp.c (the remaining fork() user, excluded by default). So
  # the stock build target is exactly the set we want; `make install` places
  # dropbear in sbin and the client tools in bin.
  installTargets = [ "install" ];

  passthru.checks =
    let
      tcpSpawn = stdenv.mkDerivation {
        name = "dropbear-tcp-spawn";
        dontUnpack = true;
        buildPhase = ''
          runHook preBuild
          $CC -Wall -Wl,--fatal-warnings -o tcp-spawn ${./tests/tcp-spawn.c}
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out/bin
          cp tcp-spawn $out/bin/tcp-spawn
          runHook postInstall
        '';
      };
    in
    {
      session = vm-test.installedTest {
        name = "dropbear-session";
        init = ./tests/session-test.sh;
        # BusyBox supplies sh (the login shell dropbear spawns), the coreutils
        # the test drives, and ip/mount.
        contents = [
          busybox
          finalAttrs.finalPackage
          tcpSpawn
        ];
      };
    };
})
