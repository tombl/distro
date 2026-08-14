{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://www.kernel.org/pub/linux/utils/util-linux/v2.42/util-linux-2.42.2.tar.xz";
    hash = "sha256-aQeFM9uPhJTbKX0cKAY5bTXwgDoFzuKwWhGkBZ/TvQQ=";
  },
  busybox,
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
    pkgs.automake
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
    # configure.ac and the included Makemodule.am fragments are patched, so
    # regenerate both configure and Makefile.in from the shipped macro set.
    autoconf
    automake
    # Keep the complete generated set newer than its inputs so make's
    # maintainer rules do not try to regenerate only part of it during build.
    touch aclocal.m4 config.h.in
    find . -name Makefile.in -exec touch {} +
    touch configure
  '';

  postBuild = ''
    make test_fileutils test_pager test_switch_root test_ttymsg test_sulogin \
      test_mount_context_mount
  '';

  postInstall = ''
    mkdir -p "$out/libexec/util-linux-tests"
    cp test_fileutils test_pager test_switch_root test_ttymsg test_sulogin \
      test_mount_context_mount \
      "$out/libexec/util-linux-tests/"
  '';

  # Upstream's default suite is the baseline. BusyBox overlap is deliberately
  # irrelevant: callers asking for util-linux should get the real program.
  # Optional target libraries are enabled when the package scope has them, and
  # ordinary heap-buffer mmap uses and fork+exec sites are ported below.
  #
  # Current target omissions:
  #   * ipcmk/ipcrm/ipcs/lsipc require System V IPC; CONFIG_SYSVIPC is disabled
  #     in the shipped wasm kernel configuration.
  # Callback clone is used only on wasm where child-only setup cannot be
  # expressed as posix_spawn actions. Without CLONE_VM the kernel snapshots
  # the address space and waits synchronously for the copy; it returns
  # EOPNOTSUPP when the caller has more than one mm user. These utilities are
  # single-threaded at their clone sites. Native builds retain upstream fork.
  #
  # Timer-backed behavior:
  #   * flock -w <timeout> uses setitimer/SIGALRM; the spawn check holds a
  #     conflicting lock and asserts both its timeout status and elapsed time.
  patches = [
    ./configure-platform-programs.patch
    ./foreground-only.patch
    ./sulogin-callback-clone.patch
    ./readprofile-posix-spawn.patch
    ./namespace-no-fork.patch
    ./fsck-callback-clone.patch
    ./switch-root-no-fork.patch
    ./wall-no-fork.patch
    # Preserve ul_restricted_path_oper's privilege boundary with a private
    # callback-clone child; the parent retains its effective credentials.
    ./fileutils-callback-clone.patch
    # setsid's callback child performs setsid(), optional TIOCSCTTY, and exec,
    # preserving the upstream child PID == session ID and --ctty semantics.
    ./setsid-callback-clone.patch
    ./flock-posix-spawn.patch
    # pager_preexec remains child-local, including its LESS/LV defaults.
    ./pager-callback-clone.patch
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
    ./fincore-cachestat.patch
    ./libblkid-no-mmap.patch
    ./cramfs-no-mmap.patch
    ./libblkid-no-fork.patch
    # Callback children preserve external helpers and mount -a -F. Only the
    # generic double-return fork API and config-disabled idmap creation remain
    # unavailable on wasm.
    ./libmount-no-fork.patch
    # uuidd uses a self-pipe for its service signals and callback clones for
    # musl's double-fork daemon continuation on wasm; native paths are intact.
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
    "--with-libz"
    "--without-cap-ng"
    "--without-selinux"
    "--without-audit"
    "--without-btrfs"
    "--without-econf"
    "--without-user"

    # These interfaces have no usable backing in the shipped guest: the wasm
    # architecture selects ARCH_NO_SWAP, CONFIG_ADVISE_SYSCALLS is disabled,
    # virtio-blk has no eject operation, and none of ldattach's attachable
    # protocol line disciplines is configured. Keep the independently useful
    # mkswap utility enabled.
    "--disable-swapon"
    "--disable-eject"
    "--disable-fadvise"
    "--disable-ldattach"

    # System V IPC is absent from the shipped kernel configuration.
    "--disable-ipcmk"
    "--disable-ipcrm"
    "--disable-ipcs"
    "--disable-lsipc"

    # Libraries used throughout the suite, static only.
    "--enable-libuuid"
    "--enable-libsmartcols"
  ];

  passthru.apk = {
    depends = [
      "busybox"
      "file"
      "ncurses"
    ];
    # util-linux intentionally owns kill when installed alongside coreutils.
    replaces = [
      "busybox"
      "coreutils"
    ];
  };

  passthru.checks =
    let
      check =
        name: init:
        vm-test.installedTest {
          name = "util-linux-${name}";
          inherit init;
          files = {
            "/test_fileutils" = {
              source = "${finalAttrs.finalPackage}/libexec/util-linux-tests/test_fileutils";
              mode = "0755";
            };
            "/test_pager" = {
              source = "${finalAttrs.finalPackage}/libexec/util-linux-tests/test_pager";
              mode = "0755";
            };
            "/test_switch_root" = {
              source = "${finalAttrs.finalPackage}/libexec/util-linux-tests/test_switch_root";
              mode = "0755";
            };
            "/test_ttymsg" = {
              source = "${finalAttrs.finalPackage}/libexec/util-linux-tests/test_ttymsg";
              mode = "0755";
            };
            "/test_sulogin" = {
              source = "${finalAttrs.finalPackage}/libexec/util-linux-tests/test_sulogin";
              mode = "0755";
            };
            "/test_mount_context_mount" = {
              source = "${finalAttrs.finalPackage}/libexec/util-linux-tests/test_mount_context_mount";
              mode = "0755";
            };
          };
          contents = [
            busybox
            file
            ncurses
            finalAttrs.finalPackage
          ];
        };
    in
    {
      text = check "text" ./text-test.sh;
      spawn = check "spawn" ./spawn-test.sh;
      pty = check "pty" ./pty-test.sh;
      programs = check "programs" ./programs-test.sh;
    };
})
