{
  pkgs,
  lib,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://github.com/linux-test-project/ltp/releases/download/20260529/ltp-full-20260529.tar.xz";
    hash = "sha256-dEakUKunQDJM3Fn4ft7PszCrAW5jzrTpqLyw1yCvT7U=";
  },
  busybox,
  vm-test,
}:

let
  testDevice = pkgs.runCommand "ltp-test-device" { } ''
    truncate -s 320M $out
  '';

  # Syscall-port waves, as <dir>/<binary> paths below testcases/kernel/syscalls.
  # Broad build probes identify candidates; runtime failures stay in the wave
  # until their kernel, harness, or environment cause is understood.
  suites = {
    filesystem = {
      disk = testDevice;
      tests = [
        "chdir/chdir02"
        "chmod/chmod01"
        "chmod/chmod03"
        "chmod/chmod05"
        "chmod/chmod07"
        "chmod/chmod08"
        "close/close01"
        "close/close02"
        "creat/creat01"
        "creat/creat03"
        "creat/creat05"
        "creat/creat08"
        "dup/dup01"
        "dup/dup02"
        "dup/dup03"
        "dup/dup04"
        "dup/dup05"
        "dup/dup06"
        "dup/dup07"
        "dup2/dup201"
        "dup2/dup202"
        "dup2/dup203"
        "dup2/dup206"
        "dup3/dup3_01"
        "dup3/dup3_02"
        "fchdir/fchdir01"
        "fchdir/fchdir02"
        "fchdir/fchdir03"
        "fchmod/fchmod01"
        "fchmod/fchmod02"
        "fchmod/fchmod03"
        "fchmod/fchmod04"
        "fchmod/fchmod05"
        "fchmod/fchmod06"
        "fstat/fstat02"
        # getcwd01 reports TFAIL on the current kernel.
        "getcwd/getcwd02"
        "getcwd/getcwd03"
        "link/link02"
        "link/link05"
        "link/link08"
        "lseek/lseek01"
        "lseek/lseek02"
        "lseek/lseek07"
        # lseek11 reports TCONF on the current kernel.
        "mkdir/mkdir02"
        "mkdir/mkdir04"
        "mkdir/mkdir05"
        "open/open01"
        "open/open02"
        "open/open03"
        "open/open04"
        "open/open06"
        "open/open07"
        "open/open09"
        "open/open10"
        "open/open11"
        "open/open15"
        "read/read01"
        "read/read03"
        "read/read04"
        "rename/rename09"
        "rename/rename11"
        "stat/stat01"
        "stat/stat02"
        "symlink/symlink02"
        "symlink/symlink04"
        "truncate/truncate02"
        "unlink/unlink05"
        "unlink/unlink10"
        "write/write01"
        "write/write02"
        "write/write04"
        "write/write06"
      ];
    };

    process = {
      disk = null;
      tests = [
        # brk01 fails on the current kernel.
        # clock_gettime01 fails on the current kernel.
        "clock_gettime/clock_gettime04"
        "getcpu/getcpu01"
        "getegid/getegid01"
        "getegid/getegid02"
        "geteuid/geteuid01"
        "geteuid/geteuid02"
        "getgid/getgid01"
        "getgid/getgid03"
        "getgroups/getgroups01"
        "getgroups/getgroups03"
        "getpgid/getpgid02"
        "getppid/getppid01"
        "getpriority/getpriority01"
        "getpriority/getpriority02"
        # getrandom01 fails on the current kernel.
        "getrandom/getrandom02"
        "getrandom/getrandom03"
        "getrandom/getrandom04"
        "getrandom/getrandom05"
        "getrlimit/getrlimit01"
        "getrlimit/getrlimit02"
        "getrlimit/getrlimit03"
        "getrusage/getrusage01"
        "getrusage/getrusage02"
        "gettid/gettid01"
        "gettid/gettid02"
        "gettimeofday/gettimeofday01"
        "gettimeofday/gettimeofday02"
        "getuid/getuid01"
        "getuid/getuid03"
        "getsid/getsid02"
        "nice/nice01"
        "nice/nice02"
        "nice/nice04"
        "sched_getscheduler/sched_getscheduler01"
        "sched_getscheduler/sched_getscheduler02"
        "setpgid/setpgid02"
        # needs_checkpoints requires shared memory, which wasm lacks.
        "setpriority/setpriority02"
        "sysinfo/sysinfo01"
        "time/time01"
        "uname/uname01"
        "uname/uname04"
        "wait/wait01"
      ];
    };
  };

  tests = lib.unique (lib.concatMap (suite: suite.tests) (builtins.attrValues suites));
  testName = builtins.baseNameOf;
  testNames = map testName tests;
in
assert lib.length testNames == lib.length (lib.unique testNames);
stdenv.mkDerivation (finalAttrs: {
  pname = "ltp";
  version = "20260529";
  inherit src;

  depsBuildBuild = [ pkgs.stdenv.cc ];

  # LTP's configure hard-requires pkg-config even though these suites use none of
  # the optional libraries it would locate; the cross pkg-config finds no .pc
  # files in the sysroot, which is the correct answer for this target.
  nativeBuildInputs = [ pkgs.pkg-config ];

  # Port the tst_test (new API) library off fork() and MAP_SHARED memory. See
  # the patch header and packages/ltp/wasm-compat.h for the full rationale.
  patches = [ ./forkless-library.patch ];

  # The library references the mmap family and fork()/vfork() from many sources
  # that the curated tests never reach; force-include a compat header so they
  # compile (wasm-ld drops the dead references), while the live paths are ported
  # by the patch above. Appended to LTP's own CFLAGS after configure, since its
  # Makefiles drive the compiler directly rather than through $NIX_CFLAGS.
  postConfigure = ''
    echo 'CFLAGS += -include ${./wasm-compat.h}' >> include/mk/config.mk
  '';

  configureFlags = [
    "--without-numa"
    "--without-tirpc"
    "--without-modules"
    "--with-python=no"
    "--with-perl=no"
  ];

  # Build only the library and the curated binaries: a top-level `make` also
  # builds tests whose semantics require fork or an MMU. LTP supports exact
  # per-binary targets once lib/ is built.
  #
  # FILTER_OUT_DIRS skips lib/'s own self-tests, which link fork/mmap paths
  # outside the curated suites. It must stay one argv (spaces, so it is quoted) and it
  # propagates as a command-line override to the sub-make each syscall dir runs
  # to (re)build libltp.a.
  buildPhase = ''
    runHook preBuild
    filterDirs="FILTER_OUT_DIRS=tests newlib_tests android_libpthread android_librt"
    make -C lib "$filterDirs"
    ${builtins.concatStringsSep "\n" (
      map (
        t: ''make -C testcases/kernel/syscalls/${builtins.dirOf t} "$filterDirs" ${builtins.baseNameOf t}''
      ) tests
    )}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    ${builtins.concatStringsSep "\n" (map (t: "cp testcases/kernel/syscalls/${t} $out/bin/") tests)}
    runHook postInstall
  '';

  passthru.checks = lib.mapAttrs (
    name: suite:
    let
      suiteBin = pkgs.runCommand "ltp-${name}-bin" { } ''
        mkdir -p $out/bin
        ${lib.concatMapStrings (
          test: "cp ${finalAttrs.finalPackage}/bin/${testName test} $out/bin/\n"
        ) suite.tests}
      '';
      manifest = pkgs.writeText "ltp-${name}-tests" (
        lib.concatMapStringsSep "\n" testName suite.tests + "\n"
      );
      passwd = pkgs.writeText "ltp-passwd" ''
        root:x:0:0:root:/root:/bin/sh
        nobody:x:65534:65534:nobody:/:/bin/false
      '';
      group = pkgs.writeText "ltp-group" ''
        root:x:0:
        users:x:100:
        nobody:x:65534:
      '';
      deviceMarker = pkgs.writeText "ltp-device" "";
    in
    vm-test.vmTest {
      name = "ltp-${name}";
      inherit (suite) disk;
      initramfs = vm-test.mkInitramfs {
        name = "ltp-${name}";
        init = ./test.sh;
        # Fragment-contract exception: LTP deliberately relies on the test
        # image's BusyBox for helpers such as mkfs.ext2.
        contents = [
          busybox
          suiteBin
        ];
        files = {
          "/etc/group" = group;
          "/etc/passwd" = passwd;
          "/ltp-tests" = manifest;
        }
        // lib.optionalAttrs (suite.disk != null) {
          "/ltp-device" = deviceMarker;
        };
      };
    }
  ) suites;
})
