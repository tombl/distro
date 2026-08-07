{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://sqlite.org/2025/sqlite-autoconf-3510000.tar.gz";
    hash = "sha256-IbgsC+KGI0uWM4PS+bKpLfbE7ciE1fpz9Jhj9+qEiVA=";
  },
  readline,
  ncurses,
  vm-test,
  busybox,
}:

let
  package = stdenv.mkDerivation (finalAttrs: {
    pname = "sqlite3";
    version = "3.51.0";
    inherit src;
    passthru.apk.replaces = [ "busybox" ];

    # sqlite's configure builds a code generator with the build compiler.
    depsBuildBuild = [ pkgs.stdenv.cc ];

    buildInputs = [
      readline
      ncurses
    ];

    # readline gives the CLI shell line editing and pulls termcap from ncurses.
    # Cross builds skip autosetup's readline auto-search, so the include and
    # link flags are handed over explicitly (cflags must contain -I).
    configureFlags = [
      "--disable-shared"
      "--enable-readline"
      "--with-readline-cflags=-I${readline}/include"
    ];

    # The ldflags value contains spaces, so it goes through the array form that
    # preserves it as a single argument rather than the space-joined string.
    preConfigure = ''
      configureFlagsArray+=(
        "--with-readline-ldflags=-L${readline}/lib -lreadline -L${ncurses}/lib -lncursesw"
      )
    '';

    env.NIX_CFLAGS_COMPILE = "-DSQLITE_OMIT_WAL=1 -DSQLITE_MAX_MMAP_SIZE=0";

    passthru.checks = {
      shell = vm-test.installedTest {
        name = "sqlite3-shell";
        init = ./sqlite3-test.sh;
        contents = [
          busybox
          ncurses
          finalAttrs.finalPackage
        ];
      };
    };
  });
in
package
