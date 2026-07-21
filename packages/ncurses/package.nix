{
  pkgs,
  stdenv,
  src,
  vm-test,
  busybox,
}:

let
  package = stdenv.mkDerivation (finalAttrs: {
    pname = "ncurses";
    version = "6.6";
    inherit src;

    # ncurses compiles code generators (make_hash, make_keys) with the build
    # compiler while cross-compiling the library itself.
    depsBuildBuild = [ pkgs.stdenv.cc ];

    # The database is compiled data shared across architectures, so it is
    # copied from a build-platform ncurses of the same version below rather
    # than compiled here with a target `tic` that cannot run. The default
    # search dir is the FHS path the rootfs flattens $out/share into, so
    # setupterm() finds it at runtime with no TERMINFO in the environment.
    configureFlags = [
      "--without-shared"
      "--without-debug"
      "--without-ada"
      "--without-manpages"
      "--without-cxx-binding"
      "--without-progs"
      "--without-tests"
      "--disable-stripping"
      "--enable-widec"
      "--with-default-terminfo-dir=/share/terminfo"
      "--with-terminfo-dirs=/share/terminfo:/usr/share/terminfo:/etc/terminfo"
    ];

    preConfigure = ''
      export BUILD_CC=$CC_FOR_BUILD
      export CPP="$CC -E"
    '';

    # Build and install the libraries and headers only; the database step
    # (install.data) is skipped because it would invoke the target `tic`.
    buildFlags = [ "libs" ];
    installTargets = [
      "install.libs"
      "install.includes"
    ];

    postInstall = ''
      # Unsuffixed aliases so consumers linking -lncurses/-ltinfo resolve to
      # the widec libraries this port actually builds.
      for name in ncurses tinfo form panel menu; do
        if [ -f $out/lib/lib''${name}w.a ]; then
          ln -sf lib''${name}w.a $out/lib/lib$name.a
        fi
      done

      # Headers install under include/ncursesw; surface them at include/ too so
      # -I$out/include resolves <curses.h>, <term.h>, <termcap.h>.
      ln -sf ncursesw $out/include/ncurses
      for header in $out/include/ncursesw/*.h; do
        ln -sf ncursesw/$(basename $header) $out/include/$(basename $header)
      done

      mkdir -p $out/share
      cp -r ${pkgs.ncurses}/share/terminfo $out/share/terminfo
    '';

    passthru.checks =
      let
        # A wasm test binary needs a stack larger than the toolchain's tiny
        # default: setupterm() overflows it loading the bigger terminfo entries
        # (see PLATFORM ISSUES in the port notes).
        ncurses-test = stdenv.mkDerivation {
          name = "ncurses-test";
          dontUnpack = true;
          buildInputs = [ finalAttrs.finalPackage ];
          buildPhase = ''
            $CC -Wall -Wextra -Werror \
              -o ncurses-test ${./ncurses-test.c} -lncursesw
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp ncurses-test $out/bin/
          '';
        };
      in
      {
        terminfo = vm-test.vmTest {
          name = "ncurses-terminfo";
          initramfs = vm-test.mkInitramfs {
            name = "ncurses-terminfo";
            init = ./ncurses-test.sh;
            contents = [
              busybox
              finalAttrs.finalPackage
              ncurses-test
            ];
          };
        };
      };
  });
in
package
