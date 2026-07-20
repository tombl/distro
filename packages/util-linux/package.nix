{
  pkgs,
  stdenv,
  src,
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "util-linux";
  version = "2.42.2";
  inherit src;

  # The subset relies on `--enable-<tool>` overriding `--disable-all-programs`,
  # but util-linux only wires an AC_ARG_ENABLE (a real --enable switch) for some
  # tools; the rest are on-by-default with no switch, so `--disable-all-programs`
  # turns them off with no way back. The configure.ac patch below adds a switch
  # for each such tool we want (following the upstream fallocate/unshare
  # pattern); regenerating configure from it needs autoconf.
  nativeBuildInputs = [ pkgs.autoconf ];
  postPatch = ''
    autoconf
    # Patching configure.ac makes it newer than the shipped generated files, so
    # make's maintainer rules would try to re-run aclocal/automake (absent, and
    # unneeded: no new macros, AM_CONDITIONALs or AC_DEFINEs were added). Touch
    # the generated files newest-last so they all read as up to date.
    touch aclocal.m4 config.h.in
    find . -name Makefile.in -exec touch {} +
    touch configure
  '';

  # This is a deliberately small subset of util-linux: `--disable-all-programs`
  # plus an explicit `--enable-<tool>` list of things busybox does not cover
  # well and that actually work on wasm32-unknown-linux-musl (static, no fork,
  # no mmap, no dlopen). Only libuuid and libsmartcols are built, statically,
  # because the shipped tools need nothing heavier.
  #
  # Excluded and why (one line each):
  #   * findmnt / lsblk / blkid: need libblkid, whose probe-buffer path uses an
  #     anonymous mmap as a malloc substitute (libblkid/src/probe.c); this
  #     target has no mmap, and porting libblkid is out of scope for the subset.
  #   * ipcs / ipcmk / ipcrm: SysV IPC (shared memory attach) needs mmap-family
  #     primitives that are absent here; not shipped.
  #   * script / scriptreplay: fork a pty child and need /dev/ptmx, which this
  #     platform lacks.
  #   * mount / losetup / fdisk / mkfs & friends: block-device machinery.
  #   * su / login / agetty / setpriv: PAM/tty/capability auth.
  #
  # Timer-backed behavior:
  #   * flock -w <timeout> uses setitimer/SIGALRM; the spawn check holds a
  #     conflicting lock and asserts both its timeout status and elapsed time.
  #
  # Degraded but shipped:
  #   * setsid -c (set controlling terminal) errors out: it needs
  #     ioctl(TIOCSCTTY) in the child after setsid(), which posix_spawn cannot
  #     express, and there is no controlling terminal here anyway.
  #   * setsid does start the command in a new session (verified), but the new
  #     session's id is the setsid process's own pid rather than the exec'd
  #     child's pid: musl runs setsid() inside the CLONE_VM posix_spawn child,
  #     which shares state with the spawner. Session isolation is real; only the
  #     leader-pid numbering differs from a fork-based setsid.
  patches = [
    # Add an `--enable/--disable-<tool>` switch for the on-by-default tools we
    # want in the subset, so `--disable-all-programs` can be overridden per tool.
    ./configure-enable-subset.patch
    # libcommon's ul_restricted_path_oper() forks a child to resolve a path
    # under the caller's identity; it is linked into every tool. wasm has no
    # fork() (the symbol is undeclared, a hard compile error), and this is a
    # single-user sandbox, so run the operation directly in-process.
    ./fileutils-no-fork.patch
    # wasm has no fork(): the two shipped tools that fork+exec a child are
    # converted to posix_spawn (clone+execve), following the gawk template.
    # setsid uses POSIX_SPAWN_SETSID so the child becomes a session leader.
    ./setsid-posix-spawn.patch
    ./flock-posix-spawn.patch
    # The wasm signal trampoline does not support SA_SIGINFO handlers, and an
    # interrupted blocking flock may return without preserving EINTR in errno.
    # flock's SIGALRM handler only marks expiration, so use a conventional
    # one-argument handler and make that expiration flag authoritative.
    ./timer-no-siginfo.patch
    # wasm has no mmap: look mapped its dictionary file read-only for a binary
    # search; read it into a heap buffer instead (same [front, back) range).
    ./look-no-mmap.patch
  ];

  configureFlags = [
    "--disable-shared"
    "--enable-static"
    "--disable-nls"
    "--disable-all-programs"

    # Keep the dependency surface tiny: no systemd, python, udev, ncurses,
    # readline, magic, zlib, caps, selinux, audit, btrfs, econf, libuser.
    "--without-systemd"
    "--without-python"
    "--without-udev"
    "--without-ncursesw"
    "--without-ncurses"
    "--without-tinfo"
    "--without-readline"
    "--without-libmagic"
    "--without-libz"
    "--without-cap-ng"
    "--without-selinux"
    "--without-audit"
    "--without-btrfs"
    "--without-econf"
    "--without-user"
    "--without-util"

    # Libraries the subset needs, static only.
    "--enable-libuuid"
    "--enable-libsmartcols"

    # The tool subset.
    "--enable-getopt" # GNU-style option parser for shell scripts
    "--enable-column" # columnate lists (libsmartcols)
    "--enable-hexdump" # canonical hex/ASCII dumps
    "--enable-rev" # reverse characters of each line
    "--enable-colrm" # remove columns from each line
    "--enable-look" # dictionary prefix search (mmap patched out)
    "--enable-namei" # follow a pathname, reporting each component
    "--enable-whereis" # locate binaries/manuals in known paths
    "--enable-cal" # calendar
    "--enable-uuidgen" # generate UUIDs (libuuid)
    "--enable-uuidparse" # decode a UUID's version/variant (libuuid, libsmartcols)
    "--enable-mcookie" # random 128-bit cookie
    "--enable-rename" # bulk rename by string substitution
    "--enable-prlimit" # get/set resource limits (libsmartcols)
    "--enable-setsid" # run a command in a new session (posix_spawn)
    "--enable-flock" # advisory file locking (posix_spawn for -c)
  ];

  passthru.checks =
    let
      # Ship only the binaries into the initramfs, dropping the unused
      # lib/include/share weight.
      utilLinuxBin = pkgs.runCommand "util-linux-bin" { } ''
        mkdir -p $out/bin
        cp ${finalAttrs.finalPackage}/bin/* $out/bin/
      '';
      check =
        name: init:
        vm-test.vmTest {
          name = "util-linux-${name}";
          initramfs = vm-test.mkInitramfs {
            name = "util-linux-${name}";
            inherit init;
            # busybox first, util-linux last: the GNU binaries shadow busybox's
            # applets (cal, rev, hexdump, flock, setsid, getopt, look, ...).
            contents = [
              busybox
              utilLinuxBin
            ];
          };
        };
    in
    {
      text = check "text" ./text-test.sh;
      spawn = check "spawn" ./spawn-test.sh;
    };
})
