{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://ftp.gnu.org/gnu/bash/bash-5.3.tar.gz";
    hash = "sha256-yDRoQcHzXgMUcaxNq9WMezU6zwzZp4Z4T2oD2qyfHK4=";
  },
  readline,
  ncurses,
  vm-test,
  busybox,
  bzip2,
}:

let
  # Official GNU Bash 5.3 patch series, fetched the same way as nixpkgs.
  gnuPatches =
    map
      (
        patch:
        pkgs.fetchurl {
          url = "mirror://gnu/bash/bash-5.3-patches/bash53-${patch.number}";
          inherit (patch) hash;
        }
      )
      [
        {
          number = "001";
          hash = "sha256-H2CENDZK+GubRciw6j+zsWX7gw0naX5s38esF97jKH8=";
        }
        {
          number = "002";
          hash = "sha256-44VUigATB2XseTilb73KUkR6tB+ryVol8ZreUn4oIAE=";
        }
        {
          number = "003";
          hash = "sha256-8kXZx9w/WiDYS1PSSTNHR5QJNvCdyX4dy4n8OrN9YO0=";
        }
        {
          number = "004";
          hash = "sha256-lZHSRQRVKfMvCBL5QYC52c6QI/WnZcA5uFLl38mXR9A=";
        }
        {
          number = "005";
          hash = "sha256-zKHvUtu/QzvJjjMmm2SyyBQCjv4lOL4eLJo3fakLyZ0=";
        }
        {
          number = "006";
          hash = "sha256-KRGa3e/tjv+Rrjf9UYIsMXgO4w1KKDdulgAnBsmV/xA=";
        }
        {
          number = "007";
          hash = "sha256-wJdrv/+hRTx8/dYgWPIGoxhWj/LWkPXU+gSHk/o+spk=";
        }
        {
          number = "008";
          hash = "sha256-CXzXI8v7iQdnSsMiFAY6P9hSgmV+xbTlRNLA9xllP7Q=";
        }
        {
          number = "009";
          hash = "sha256-7uMP54pLDLL+IOAQ4AMIiZz8YT4HdOuzyFV6FVLyT4w=";
        }
      ];

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

  # GNU's release patches use -p0, while the wasm port patches use -p1.
  prePatch = ''
    for patch in ${toString gnuPatches}; do
      patch -p0 < "$patch"
    done
  '';

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
    # Target VM regressions exercise the consumers of each cache answer:
    # lastpipe's synthetic wait status, RTMIN traps, and builtin printf %a.
    "bash_cv_wexitstatus_offset=8"
    "bash_cv_unusable_rtsigs=no"
    "bash_cv_printf_a_format=yes"
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

    # Readline is statically linked, but it still loads terminal descriptions
    # at runtime. Keep the Bash filesystem fragment self-contained instead of
    # requiring callers to add a separate ncurses slice.
    mkdir -p "$out/share"
    cp -r ${ncurses}/share/terminfo "$out/share/terminfo"
  '';

  passthru.checks = {
    smoke = vm-test.vmTest {
      name = "bash-smoke";
      initramfs = vm-test.mkInitramfs {
        name = "bash-smoke";
        init = ./smoke-test.sh;
        contents = [
          busybox
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
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
