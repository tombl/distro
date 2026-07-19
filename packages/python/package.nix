{
  pkgs,
  stdenv,
  src,
  zlib,
  bzip2,
  xz,
  sqlite3,
  readline,
  ncurses,
  vm-test,
  busybox,
}:

let
  package = stdenv.mkDerivation (finalAttrs: {
    pname = "python";
    version = "3.13.14";
    inherit src;

    # Cross-compiling CPython needs a host interpreter of the *same* minor
    # version to run the freeze/regen steps; --with-build-python below points
    # at it. The build platform also compiles a few helper generators.
    depsBuildBuild = [ pkgs.stdenv.cc ];

    # Statically linked extension modules for the batteries this distro ships.
    # cc-wrapper injects each buildInput's -isystem/-L, so CPython's configure
    # finds the headers/libs through its no-pkg-config fallback checks (this
    # stdenv has no pkg-config, so every PKG_CHECK_MODULES degrades to an
    # AC_CHECK_HEADER + AC_CHECK_LIB probe).
    buildInputs = [
      zlib # zlib + binascii crc32
      bzip2 # _bz2
      xz # _lzma
      sqlite3 # _sqlite3
      readline # readline (REPL line editing)
      ncurses # _curses, and termcap backing for readline
    ];

    # subprocess must launch children on a platform with no working fork().
    # _posixsubprocess (fork_exec) is disabled below; this patch makes
    # subprocess route every launch through os.posix_spawn() instead.
    patches = [ ./subprocess-posix-spawn.patch ];

    # configure runs a host interpreter (build python of the same minor) for
    # its freeze steps and never executes the wasm binary it produces.
    configureFlags = [
      "--disable-shared"
      "--with-build-python=${pkgs.python313}/bin/python3"
      "--with-ensurepip=no" # pip needs ssl/network we don't have
      "--disable-test-modules" # skip the _test* C extensions and Lib/test

      # mimalloc (default on) and the mmap module both need <sys/mman.h>, which
      # this sysroot omits because wasm has no mmap. obmalloc falls back to
      # malloc-based arenas, so pymalloc still works.
      "--without-mimalloc"

      # Cross builds can't probe for /dev/ptmx; answer the AC_CHECK_FILE probes
      # (no ptmx/ptc device on the wasm guest anyway).
      "ac_cv_file__dev_ptmx=no"
      "ac_cv_file__dev_ptc=no"

      # The getaddrinfo "is it buggy" probe is a run test; cross builds default
      # it to "buggy" and then abort unless ipv6 is turned off. musl's
      # getaddrinfo is fine, so assert it and keep ipv6 enabled.
      "ac_cv_buggy_getaddrinfo=no"

      # Module selection. py_cv_module_<name>=n/a forces a module off.
      "py_cv_module__posixsubprocess=n/a" # fork_exec: no usable fork(); see patch
      "py_cv_module_mmap=n/a" # no <sys/mman.h>
      "py_cv_module__ctypes=n/a" # no libffi by platform policy
      "py_cv_module__ssl=n/a" # no OpenSSL yet (hashlib still works via _hacl)
      "py_cv_module__hashlib=n/a" # no OpenSSL; builtin _md5/_sha*/_blake2 cover it

      # POSIX named semaphores need sem_open(), which musl does not provide on
      # wasm (only sem_unlink/sem_getvalue/sem_timedwait link). _multiprocessing
      # can't synchronise without them, and its module also references
      # _PyMp_sem_unlink unconditionally while semaphore.c only defines it under
      # HAVE_SEM_OPEN, so leaving it enabled fails to link. It could not work
      # without fork() anyway.
      "py_cv_module__multiprocessing=n/a"
      "py_cv_module__posixshmem=n/a" # only consumed by _multiprocessing here
    ];

    # readline links against ncurses' termcap. With no pkg-config, configure's
    # readline link probe uses $LIBREADLINE_LIBS as-is; without ncurses here the
    # probe fails to resolve tgetent and disables the whole module. The bracket
    # form keeps the spaces inside one argument.
    preConfigure = ''
      export LIBREADLINE_LIBS="-lreadline -lncursesw"
    '';

    # A minimal smoke test at build time: the interpreter binary is wasm, so it
    # cannot run here; just confirm it and the stdlib landed.
    postInstall = ''
      test -x $out/bin/python3.13
      test -f $out/lib/python3.13/os.py
    '';

    passthru.checks = {
      interpreter = vm-test.vmTest {
        name = "python-interpreter";
        # A larger stack than the toolchain default is unnecessary here; the
        # 8 MiB platform default covers CPython's recursion in these tests.
        initramfs = vm-test.mkInitramfs {
          name = "python-interpreter";
          init = ./python-test.sh;
          # busybox first so its applets (echo, sh) are present; python later.
          contents = [
            busybox
            finalAttrs.finalPackage
          ];
        };
      };
    };
  });
in
package
