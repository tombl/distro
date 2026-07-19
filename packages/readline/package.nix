{
  stdenv,
  src,
  ncurses,
  vm-test,
  busybox,
}:

let
  package = stdenv.mkDerivation (finalAttrs: {
    pname = "readline";
    version = "8.3";
    inherit src;

    # termcap (tgetent/tputs/...) comes from the ncurses port rather than the
    # bundled emulation.
    buildInputs = [ ncurses ];

    # The bash_cv_* cache vars answer probes readline would otherwise settle by
    # running a target binary, which cannot happen when cross-compiling.
    configureFlags = [
      "--disable-shared"
      "--enable-static"
      "--with-curses"
      "bash_cv_termcap_lib=libncursesw"
      "bash_cv_wcwidth_broken=no"
    ];

    passthru.checks =
      let
        # rl_initialize() -> tgetent() overflows the toolchain's tiny default
        # stack (see PLATFORM ISSUES), so the test binary asks for a larger one.
        readline-echo = stdenv.mkDerivation {
          name = "readline-echo";
          dontUnpack = true;
          buildInputs = [
            finalAttrs.finalPackage
            ncurses
          ];
          buildPhase = ''
            $CC -Wall -Wextra -Werror \
              -o readline-echo ${./readline-echo.c} -lreadline -lncursesw
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp readline-echo $out/bin/
          '';
        };
      in
      {
        line-editing = vm-test.vmTest {
          name = "readline-line-editing";
          initramfs = vm-test.mkInitramfs {
            name = "readline-line-editing";
            init = ./readline-test.sh;
            contents = [
              busybox
              ncurses
              readline-echo
            ];
          };
        };
      };
  });
in
package
