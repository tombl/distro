{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://ftp.gnu.org/gnu/less/less-668.tar.gz";
    hash = "sha256-U3En8L4CnqlVu9Kkh3PhOQIoUyzGDl5msotNKtPn1Dk=";
  },
  ncurses,
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "less";
  version = "668";
  inherit src;

  # less draws the screen through termcap (tgetent/tgoto/tputs); those symbols
  # come from the ncurses port. The wasm ncurses build folds termcap into
  # libncursesw (there is no separate libtinfo), so configure's -ltinfo probes
  # miss and it settles on -lncursesw via its initscr link test.
  buildInputs = [ ncurses ];

  # Signal handlers interrupt iread() with sigsetjmp/siglongjmp. On wasm those
  # only work when every translation unit containing a call site is lowered.
  env.NIX_CFLAGS_COMPILE = "-mllvm -wasm-enable-sjlj";

  # less spawns children only through libc system()/popen() (the pager's !cmd,
  # v-to-editor, and lessopen filters); musl implements both with posix_spawn
  # (clone+execve), so no fork path is compiled and no patch is needed. less
  # uses no mmap and no SIGALRM/itimers, so those platform gaps need no patch.
  configureFlags = [
    "--with-regex=posix"
  ];

  passthru.apk = {
    depends = [ "ncurses" ];
    replaces = [ "busybox" ];
  };

  passthru.checks = {
    functionality = vm-test.installedTest {
      name = "less-functionality";
      init = ./functionality-test.sh;
      contents = [
        busybox
        ncurses
        finalAttrs.finalPackage
      ];
    };
  };
})
