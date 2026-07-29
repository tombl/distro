{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://www.kernel.org/pub/linux/utils/util-linux/v2.42/util-linux-2.42.2.tar.xz";
    hash = "sha256-aQeFM9uPhJTbKX0cKAY5bTXwgDoFzuKwWhGkBZ/TvQQ=";
  },
  bash,
  coreutils,
  file,
  ncurses,
  readline,
  sqlite3,
  zlib,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "util-linux";
  version = "2.42.2";
  inherit src;

  nativeBuildInputs = [
    pkgs.autoconf
    pkgs.pkg-config
  ];
  buildInputs = [
    ncurses
    readline
    sqlite3
    file
    zlib
  ];
  postPatch = ''
    patchShebangs tools
    autoconf
    # Patching configure.ac makes it newer than the shipped generated files, so
    # make's maintainer rules would try to re-run aclocal/automake (absent, and
    # unneeded: no new macros, AM_CONDITIONALs or AC_DEFINEs were added). Touch
    # the generated files newest-last so they all read as up to date.
    touch aclocal.m4 config.h.in
    find . -name Makefile.in -exec touch {} +
    touch configure
  '';

  # Upstream's default suite is the baseline. BusyBox overlap is deliberately
  # irrelevant: callers asking for util-linux should get the real program.
  # Optional target libraries are enabled when the package scope has them, and
  # ordinary heap-buffer mmap uses and fork+exec sites are ported below.
  #
  # The remaining omissions are actual target limits:
  #   * fsck is a parallel process orchestrator whose checker lifecycle and
  #     progress handoff require fork semantics.
  #   * fincore requires either cachestat (ENOSYS on the guest kernel) or its
  #     mmap/mincore fallback (not available on wasm).
  #   * ipcmk/ipcrm/ipcs/lsipc require System V IPC. The wasm defconfig omits
  #     it, and enabling CONFIG_SYSVIPC currently traps inside the kernel's
  #     ipcget() on the first shmget(), rather than providing usable IPC.
  #   * cramfs tools (selected only by zlib) use mmap as their filesystem image
  #     and file-input representation throughout.
  # Programs whose only unsupported mode is daemonization, namespace
  # intermediation, pager shell escape, or a forked slow-tty writer still ship;
  # their direct/foreground operation remains available.
  #
  # Timer-backed behavior:
  #   * flock -w <timeout> uses setitimer/SIGALRM; the spawn check holds a
  #     conflicting lock and asserts both its timeout status and elapsed time.
  #
  # Degraded but shipped:
  #   * setsid -c (set controlling terminal) errors out: it needs
  #     ioctl(TIOCSCTTY) in the child after setsid(), which posix_spawn cannot
  #     express, and there is no controlling terminal here anyway.
  #   * setsid's spawning paths do start the command in a new session
  #     (verified), but the new session's id is the setsid process's own pid
  #     rather than the exec'd child's pid: musl runs setsid() inside the
  #     CLONE_VM posix_spawn child, which shares state with the spawner. Session
  #     isolation is real; only the leader-pid numbering differs from a
  #     fork-based setsid. Its ordinary path remains setsid()+execvp().
  patches = [
    ./configure-platform-programs.patch
    ./foreground-only.patch
    ./namespace-no-fork.patch
    ./switch-root-no-fork.patch
    ./wall-no-fork.patch
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
    # Common pager support only needs a pipe attached to an exec'd shell.
    ./pager-posix-spawn.patch
    # script's PTY child uses callback clone so its existing setsid, TIOCSCTTY,
    # stdio attachment, and exec sequence runs on a fresh child stack.
    ./script-callback-clone.patch
    # signalfd is absent; retain the same poll-driven signal model with a
    # nonblocking self-pipe populated by minimal signal handlers.
    ./pty-session-self-pipe.patch
    # wasm has no mmap: look mapped its dictionary file read-only for a binary
    # search; read it into a heap buffer instead (same [front, back) range).
    ./look-no-mmap.patch
    # dmesg and libblkid use mappings as ordinary read/heap buffers. Preserve
    # their behavior with explicit allocation and reads.
    ./dmesg-no-mmap.patch
    ./libblkid-no-mmap.patch
    ./libblkid-no-fork.patch
    # Direct mount operations and the libmount inspection APIs work. Restrict
    # only external helpers, idmapped namespaces, and explicit parallel mode.
    ./libmount-no-fork.patch
    ./swapon-eject-posix-spawn.patch
    # uuidd's service works in its existing foreground mode; only daemonizing
    # via fork is unavailable.
    ./uuidd-no-daemon.patch
  ];

  configureFlags = [
    "--disable-shared"
    "--enable-static"
    "--disable-nls"
    "--disable-makeinstall-chown"
    "--disable-makeinstall-setuid"

    # Optional integrations that do not exist in the wasm package scope, or
    # whose only consumer cannot work on this target.
    "--without-systemd"
    "--without-python"
    "--without-udev"
    "--without-ncurses"
    "--without-libz"
    "--without-cap-ng"
    "--without-selinux"
    "--without-audit"
    "--without-btrfs"
    "--without-econf"
    "--without-user"

    # These programs fundamentally require VM mappings or general fork
    # semantics, rather than a fork+exec operation we can express with spawn.
    "--disable-fincore"
    "--disable-fsck"
    "--disable-ipcmk"
    "--disable-ipcrm"
    "--disable-ipcs"
    "--disable-lsipc"

    # Libraries used throughout the suite, static only.
    "--enable-libuuid"
    "--enable-libsmartcols"
  ];

  postInstall = ''
    # cfdisk, ul and setterm resolve the terminfo database at this FHS path.
    mkdir -p $out/share
    cp -r ${ncurses}/share/terminfo $out/share/
    mkdir -p $out/usr/share
    cp -r ${file}/usr/share/misc $out/usr/share/
  '';

  passthru.checks =
    let
      # Ship only the binaries into the initramfs, dropping the unused
      # lib/include/share weight.
      utilLinuxBin = pkgs.runCommand "util-linux-bin" { } ''
        mkdir -p $out
        cp -a ${finalAttrs.finalPackage}/bin ${finalAttrs.finalPackage}/sbin $out/
        mkdir -p $out/share
        cp -a ${finalAttrs.finalPackage}/share/terminfo $out/share/
        mkdir -p $out/usr/share
        cp -a ${finalAttrs.finalPackage}/usr/share/misc $out/usr/share/
      '';
      bashBin = pkgs.runCommand "bash-bin" { } ''
        mkdir -p $out/bin
        cp -a ${bash}/bin/bash ${bash}/bin/sh $out/bin/
      '';
      coreutilsGnu = pkgs.runCommand "coreutils-gnu-bin" { } ''
        mkdir -p $out/gnu/bin
        cp -a ${coreutils}/bin/* $out/gnu/bin/
      '';
      check =
        name: init:
        vm-test.vmTest {
          name = "util-linux-${name}";
          initramfs = vm-test.mkInitramfs {
            name = "util-linux-${name}";
            inherit init;
            # Keep coreutils in a separate prefix because both suites own kill.
            # The guest intentionally contains no BusyBox applets.
            contents = [
              bashBin
              coreutilsGnu
              utilLinuxBin
            ];
          };
        };
    in
    {
      text = check "text" ./text-test.sh;
      spawn = check "spawn" ./spawn-test.sh;
      pty = check "pty" ./pty-test.sh;
      programs = check "programs" ./programs-test.sh;
    };
})
