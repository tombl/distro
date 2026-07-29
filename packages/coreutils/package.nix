{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://ftp.gnu.org/gnu/coreutils/coreutils-9.7.tar.xz";
    hash = "sha256-TFDtvw5E4y9UPfMyOV+KiMnIeSum54fXSOIbT7qRsXA=";
  },
  bash,
  util-linux,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "coreutils";
  version = "9.7";
  inherit src;

  # gnulib's configure compiles helper generators (e.g. the man-page and
  # localization scaffolding) with the build compiler.
  depsBuildBuild = [ pkgs.stdenv.cc ];

  # What is excluded or degraded on this platform, and why:
  #   * stdbuf is not installed at all (see --enable-no-install-program below):
  #     it only works by LD_PRELOADing libstdbuf.so, and this target has no
  #     dlopen and no dynamic linking, so it could never function.
  #   * timeout is installed; its posix_spawn launch path and
  #     setitimer/SIGALRM enforcement are covered end to end by the spawn check.
  #   * sort's --compress-program forked a helper; with fork forced off (below)
  #     autoconf selects sort's fork-free path, which silently drops that option.
  # Everything else, including upstream's optional arch and hostname programs,
  # is installed and exercised by the passthru VM checks.
  patches = [
    # gnulib's cwd-saving fallback forks; guard it behind HAVE_WORKING_FORK.
    ./savewd-no-fork.patch
    # Direct fork+exec callers converted to posix_spawn (clone+exec).
    ./install-posix-spawn.patch
    ./split-posix-spawn.patch
    ./timeout-posix-spawn.patch
  ];

  configureFlags = [
    "--disable-nls"
    "--disable-acl"
    "--disable-libcap"
    "--without-selinux"
    "--enable-install-program=arch,hostname"
    # stdbuf works by LD_PRELOADing a shared libstdbuf.so; this is a
    # static-only, no-dlopen target, so it can never function here.
    "--enable-no-install-program=stdbuf"
  ];

  # The stdenv CONFIG_SITE states that fork/vfork are absent. gnulib therefore
  # selects its fork-free paths (e.g. sort drops --compress-program); the
  # remaining direct fork+exec callers are converted by the patches above.

  # The real tree is the "." entry of SUBDIRS; gnulib-tests is test-only
  # scaffolding that pulls in mmap-based helpers (vma-iter) that cannot compile
  # here, and po is dead weight with NLS disabled. Build and install just ".".
  makeFlags = [ "SUBDIRS=." ];

  passthru.checks =
    let
      bashBin = pkgs.runCommand "bash-bin" { } ''
        mkdir -p $out/bin
        cp -a ${bash}/bin/bash ${bash}/bin/sh $out/bin/
      '';
      # coreutils and util-linux both own /bin/kill. Keep GNU coreutils in a
      # distinct prefix so the image contains both real suites without path
      # ownership depending on composition order.
      coreutilsGnu = pkgs.runCommand "coreutils-gnu-bin" { } ''
        mkdir -p $out/gnu/bin
        cp -a ${finalAttrs.finalPackage}/bin/* $out/gnu/bin/
      '';
      utilLinuxCommands = pkgs.runCommand "util-linux-commands" { } ''
        mkdir -p $out
        cp -a ${util-linux}/bin ${util-linux}/sbin $out/
      '';
      check =
        name: init:
        vm-test.vmTest {
          name = "coreutils-${name}";
          initramfs = vm-test.mkInitramfs {
            name = "coreutils-${name}";
            inherit init;
            contents = [
              bashBin
              utilLinuxCommands
              coreutilsGnu
            ];
          };
        };
    in
    {
      fileops = check "fileops" ./fileops-test.sh;
      textops = check "textops" ./textops-test.sh;
      spawn = check "spawn" ./spawn-test.sh;
      programs = check "programs" ./programs-test.sh;
    };
})
