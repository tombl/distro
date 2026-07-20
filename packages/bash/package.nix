{
  pkgs,
  stdenv,
  src,
  readline,
  ncurses,
  vm-test,
  busybox,
  bzip2,
}:

let
  testScripts = pkgs.runCommand "bash-test-scripts" { } ''
    mkdir -p $out/tests $out/repo-tests
    cp ${./functional-test.sh} $out/tests/bash-functional-test.sh
    cp ${../bzip2/roundtrip-test.sh} $out/repo-tests/bzip2-roundtrip-test.sh
  '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "bash";
  version = "5.3";
  inherit src;

  patches = [
    ./wasm-anonfile.patch
    ./wasm-callback-clone.patch
    ./wasm-execute-callbacks.patch
    ./wasm-fork-shim.patch
    ./wasm-main.patch
    ./wasm-simple-command-clone.patch
    ./wasm-disk-command-clone.patch
    ./wasm-process-substitution-clone.patch
    ./wasm-coproc-clone.patch
    ./wasm-null-command-clone.patch
  ];

  depsBuildBuild = [ pkgs.stdenv.cc ];

  buildInputs = [
    readline
    ncurses
  ];

  postPatch = ''
    cp ${./bash-clone.c} bash-clone.c
    cp ${./bash-clone.h} bash-clone.h
    cp ${./fork-shim.c} fork-shim.c
  '';

  configureFlags = [
    "--enable-static-link"
    "--with-installed-readline"
    "--without-bash-malloc"
    "--disable-nls"

    # Bash's runtime probes cannot execute target programs while cross
    # compiling. Each answer below is established by the platform checks.
    "bash_cv_job_control_missing=present"
    "bash_cv_sys_named_pipes=present"
    "bash_cv_getcwd_malloc=yes"
    "bash_cv_getenv_redef=yes"
    "bash_cv_func_sigsetjmp=present"
    # Device setup links /dev/fd to the mounted procfs descriptor directory.
    # The VM regression also proves an inherited descriptor remains usable
    # through callback clone and exec.
    "bash_cv_dev_fd=standard"
    "bash_cv_pgrp_pipe=no"
    "bash_cv_wcontinued_broken=no"
  ];

  # Bash links LOCAL_LIBS into the shell only. Preserve both paths as one
  # configure assignment; the temporary shim remains a loud link guard until
  # every make_child caller has a callback continuation.
  preConfigure = ''
    configureFlagsArray+=("LOCAL_LIBS=./bash-clone.o ./fork-shim.o")
  '';

  # Current build-platform GCC defaults to C23, where bool is a keyword.
  # Bash's target configure probe runs in the target compiler's older mode and
  # conditionally typedefs bool, so its build-only generators must use the
  # matching pre-C23 language rules.
  env.CFLAGS_FOR_BUILD = "-std=gnu17 -g";

  # Bash has its own --enable-static-link switch; the generic stdenv's
  # --disable-static flag is not a recognized Bash configure option.
  dontDisableStatic = true;

  # Bash uses sigsetjmp/siglongjmp for non-local error and signal handling.
  # Wasm SjLj lowering must therefore cover every translation unit that can
  # contain a call site, rather than just the final link. Bash's top-level
  # .NOEXPORT prevents NIX_CFLAGS_COMPILE from reaching recursive make jobs,
  # so these must be ordinary target CFLAGS.
  env.CFLAGS = "-g -O2 -mllvm -wasm-enable-sjlj";

  preBuild = ''
    $CC $CPPFLAGS $CFLAGS -c bash-clone.c -o bash-clone.o
    $CC $CPPFLAGS $CFLAGS -c fork-shim.c -o fork-shim.o
  '';

  enableParallelBuilding = true;

  postInstall = ''
    ln -s bash "$out/bin/sh"
  '';

  passthru.checks = {
    smoke = vm-test.vmTest {
      name = "bash-smoke";
      initramfs = vm-test.mkInitramfs {
        name = "bash-smoke";
        init = ./smoke-test.sh;
        contents = [
          busybox
          ncurses
          finalAttrs.finalPackage
          testScripts
        ];
      };
    };

    repo-script = vm-test.vmTest {
      name = "bash-repo-script";
      initramfs = vm-test.mkInitramfs {
        name = "bash-repo-script";
        init = ./repo-test-init.sh;
        contents = [
          busybox
          bzip2
          ncurses
          finalAttrs.finalPackage
          testScripts
        ];
      };
    };

    interactive = vm-test.vmTest {
      name = "bash-interactive";
      initramfs = vm-test.mkInitramfs {
        name = "bash-interactive";
        init = ./interactive-test.sh;
        contents = [
          busybox
          ncurses
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
