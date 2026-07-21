{
  stdenv,
  src,
  ncurses,
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "vim";
  version = "9.1.2148";
  inherit src;

  # vim draws the screen and reads terminfo through termlib (tgetent/tputs/...);
  # those symbols come from the ncurses port. That port folds termcap into
  # libncursesw (there is no separate libtinfo) and exposes an unsuffixed
  # libncurses.a alias, so --with-tlib=ncurses below resolves the link test to
  # -lncurses. The terminfo database ships at /share/terminfo (ncurses port),
  # which the runtime environment finds with no TERMINFO set.
  buildInputs = [ ncurses ];

  patches = [ ./wasm-sys-wait.patch ];

  # --- how vim starts child processes on this platform -------------------------
  #
  # vim shells out from three kinds of site: mch_call_shell() (":!", ":r!", the
  # ":%!filter" commands, the shell for K/formatprg/keywordprg), mch_job_start()
  # (job_start(), ":terminal", async channels -- FEAT_JOB_CHANNEL), and cscope
  # (if_cscope.c -- FEAT_CSCOPE). All three reach a raw fork()/exec in os_unix.c.
  # wasm musl has no fork() (the symbol does not exist), so every fork() caller
  # that survives into the object files is a link error.
  #
  # We remove them by construction rather than by patching:
  #  * USE_SYSTEM (-DUSE_SYSTEM, see env below) switches mch_call_shell() to its
  #    system() implementation (mch_call_shell_system). musl's system() is
  #    posix_spawn (clone+execve), which this kernel supports. With USE_SYSTEM
  #    defined and channels off, the fork()-based mch_call_shell_fork() and its
  #    set_child_environment() helper are #if'd out entirely. version.c then
  #    reports "+system()" instead of "+fork()", which the vm check asserts as
  #    proof the switch took effect.
  #  * --disable-channel drops FEAT_JOB_CHANNEL (job.c/channel.c and the
  #    fork()-based mch_job_start), and with it FEAT_TERMINAL (which requires a
  #    channel). :terminal / job_start() are out of scope with no way to fork.
  #  * FEAT_CSCOPE is HUGE-only and ENABLE_CSCOPE-gated; --with-features=normal
  #    never defines it, and --disable-cscope makes that explicit. The remaining
  #    fork() references live in the GUI and X11 code, which --disable-gui
  #    --without-x compile out.
  #
  # One small patch is still needed, and it is a consequence of USE_SYSTEM, not
  # of the platform: os_unixx.h only pulls in <sys/wait.h> (and the W* macros)
  # #ifndef USE_SYSTEM, but wait4pid() in os_unix.c is compiled unconditionally
  # and calls waitpid(). With USE_SYSTEM defined that leaves an implicit
  # waitpid() declaration, which is a hard error under this clang. The patch
  # includes <sys/wait.h> regardless of USE_SYSTEM. (wait4pid itself is dead
  # code in this configuration -- its only callers are the fork/exec branch --
  # but it must still compile.)
  #
  # --- other platform gaps -----------------------------------------------------
  # No mmap: vim never calls mmap and nothing probes for it, so there is nothing
  #   to force off (the stdenv's config.site answer is moot here).
  # POSIX timers work on the pinned kernel. timer_create() is only consulted
  #   for nanosecond profiling precision (HUGE-only FEAT_PROFILE), but the
  #   configure cache still records the platform truth. Vim's mapping timeouts
  #   and timer_start() use poll() deadlines in the main input loop. The only
  #   alarm()/SIGALRM call sites are X11 and cscope, both off.
  # sigaltstack() returns ENOSYS on this platform. vim would call it once,
  #   unconditionally at startup (mch_early_init -> init_signal_stack), to
  #   install an alternate stack so a stack-overflow SIGSEGV can still be
  #   reported. The stdenv CONFIG_SITE answers
  #   ac_cv_func_sigaltstack=no, so configure leaves HAVE_SIGALTSTACK undefined;
  #   with HAVE_SIGSTACK also absent, the alternate-signal-stack block is
  #   compiled out. The cost is only a less graceful stack-overflow message.
  configureFlags = [
    "--with-features=normal"
    "--with-tlib=ncurses"
    "--enable-fail-if-missing" # loud: abort configure if a wanted feature is unbuildable
    "--disable-gui"
    "--without-x"
    "--disable-netbeans"
    "--disable-channel" # removes FEAT_JOB_CHANNEL -> the fork()-based mch_job_start
    "--disable-cscope" # explicit: cscope's fork() must never be compiled
    "--disable-gpm" # console-mouse via libgpm, not shipped
    "--disable-sysmouse"
    "--disable-canberra" # desktop sound
    "--disable-libsodium" # sodium-backed crypt
    "--disable-selinux"
    "--disable-nls"
    # No language interpreters: all are dynamically loaded or out of scope, and
    # there is no dlopen on this platform anyway.
    "--disable-luainterp"
    "--disable-mzschemeinterp"
    "--disable-perlinterp"
    "--disable-pythoninterp"
    "--disable-python3interp"
    "--disable-rubyinterp"
    "--disable-tclinterp"
  ];

  # vim's configure is cross-hostile: many probes are AC_RUN_IFELSE, which cannot
  # execute a wasm binary on the build host. Each such probe has a
  # cross-compilation fallback, but some fallbacks guess wrong for this target,
  # so we state the platform truth as the cache value (configure honours a
  # pre-set vim_cv_* from the environment and skips the run). The generic
  # autoconf lies (mmap, dlopen) are already answered by the stdenv's config.site.
  #   toupper_broken=no          musl toupper() is correct.
  #   getcwd_broken=no           musl getcwd() returns an absolute path, no ".".
  #   stat_ignores_slash=no      Linux stat("file/") fails with ENOTDIR; the
  #                              cross fallback wrongly guesses "yes".
  #   memmove_handles_overlap=yes  musl memmove() handles overlap; vim uses it
  #                                for mch_memmove (memcpy/bcopy probes skipped).
  #   terminfo=yes / tgetent=zero  ncurses is a terminfo library and returns 0
  #                                (TGETENT_ZERO_ERR) for an unknown terminal.
  #   timer_create_works=yes     POSIX timer creation and delivery work.
  preConfigure = ''
    export vim_cv_toupper_broken=no
    export vim_cv_getcwd_broken=no
    export vim_cv_stat_ignores_slash=no
    export vim_cv_memmove_handles_overlap=yes
    export vim_cv_terminfo=yes
    export vim_cv_tgetent=zero
    export vim_cv_timer_create_works=yes
    # Route every shell-out through system()/posix_spawn (see the long note).
    export NIX_CFLAGS_COMPILE="''${NIX_CFLAGS_COMPILE-} -DUSE_SYSTEM"
  '';

  enableParallelBuilding = true;

  # The package is overlaid into an FHS guest, so the compiled runtime path must
  # name that guest path rather than this derivation's Nix store prefix.
  makeFlags = [ "VIMRUNTIMEDIR=/usr/share/vim/vim91" ];

  # The granular install targets live in src/Makefile, not the top-level one,
  # so descend into src first. installruntime's help-tag rule knows it is cross
  # compiling and retains the distributed tags instead of trying to execute the
  # freshly built wasm Vim. STRIP=true likewise stops the upstream Makefile
  # from invoking a host strip; nix's fixupPhase uses the wrapped target tool.
  preInstall = "cd src";
  installTargets = [
    "installvimbin"
    "installtools"
    "installruntime"
  ];
  installFlags = [ "STRIP=true" ];

  postInstall = ''
    # Upstream installs runtime data below $prefix/share. Relocate it to the
    # path compiled above so the fragment lands at the same path in the guest.
    mkdir -p $out/usr/share
    mv $out/share/vim $out/usr/share/vim

    # libncurses is linked statically, but terminal initialization still reads
    # the compiled database at runtime. Make Vim's fragment self-contained.
    mkdir -p $out/share
    cp -r ${ncurses}/share/terminfo $out/share/terminfo
  '';

  passthru.checks = {
    editing = vm-test.vmTest {
      name = "vim-editing";
      initramfs = vm-test.mkInitramfs {
        name = "vim-editing";
        init = ./editing-test.sh;
        # busybox first supplies sh (vim's system() execs /bin/sh), the coreutils
        # the script drives, and tr/echo for the filter shell-out; vim last.
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
