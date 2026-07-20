{
  stdenv,
  src,
  vm-test,
  busybox,
}:

let
  package = stdenv.mkDerivation (finalAttrs: {
    pname = "dropbear";
    version = "2026.92";
    inherit src;

    # The port's crux is fork(): wasm musl has no fork()/vfork() (the symbols do
    # not exist, so any reference fails to link). This patch rewrites the one
    # surviving, reachable fork()+exec() -- the server running the user's
    # command in svr-chansession -- to posix_spawn (clone+execve), moving the
    # pre-exec environment/cwd/privilege setup into the parent (safe in
    # single-connection inetd mode) and expressing the fd plumbing as posix_spawn
    # file actions. It also converts the shared spawn_command helper (dbutil.c),
    # stubs the pty session path (needs setsid()+TIOCSCTTY that posix_spawn
    # cannot express, and the guest has no /dev/ptmx) to fail loudly, and
    # removes the client's daemon()-based "-f" backgrounding. Every other fork()
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

    # dropbear installs to sbin; the stdenv's sbin->bin hook then moves the
    # binaries into bin and leaves sbin as a symlink to bin. That symlink
    # collides with busybox's real sbin directory when the initramfs builder
    # merges package trees (cp cannot replace a directory with a symlink), so
    # drop it -- every binary already lives in bin.
    postFixup = ''
      rm -f $out/sbin
    '';

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
        session = vm-test.vmTest {
          name = "dropbear-session";
          initramfs = vm-test.mkInitramfs {
            name = "dropbear-session";
            init = ./tests/session-test.sh;
            # busybox first supplies sh (the login shell dropbear spawns), the
            # coreutils the test drives, and ip/mount; dropbear + the listener
            # fixture last.
            contents = [
              busybox
              finalAttrs.finalPackage
              tcpSpawn
            ];
          };
        };
      };
  });
in
package
