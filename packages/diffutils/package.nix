{
  stdenv,
  src,
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "diffutils";
  version = "3.10";
  inherit src;

  configureFlags = [
    "--disable-nls"
    # diff3, sdiff, and diff --paginate spawn a child (diff, an editor, or pr)
    # with fork()+exec under HAVE_WORKING_FORK, and fall back to popen()/system()
    # otherwise. wasm has no fork(), but musl's popen()/system() are built on
    # posix_spawn, so force the no-fork path: gnulib's AC_FUNC_FORK
    # cross-compile heuristic otherwise guesses fork works and picks the dead
    # fork+exec branch. This keeps plain diff/cmp (which never fork) unchanged.
    "ac_cv_func_fork_works=no"
    "ac_cv_func_vfork_works=no"
  ];

  # gnulib's libsigsegv treats every __linux__ target as able to catch SIGSEGV
  # and recover from stack overflow, then compiles stackvma.c/sigsegv.c against
  # mmap, munmap, and mincore to locate the faulting stack VMA. wasm has none of
  # those, no memory protection, and never delivers SIGSEGV, so this machinery
  # cannot exist here. Exclude __wasm__ from the three capability macros; the
  # only use is a nice-to-have c_stack_action() diagnostic that becomes a no-op.
  # (Identical to the grep port.)
  postPatch = ''
    sed -i 's|^# define HAVE_SIGSEGV_RECOVERY 1|#if !defined __wasm__\n# define HAVE_SIGSEGV_RECOVERY 1\n#endif|' lib/sigsegv.in.h
    sed -i 's|^# define HAVE_STACK_OVERFLOW_RECOVERY 1|#if !defined __wasm__\n# define HAVE_STACK_OVERFLOW_RECOVERY 1\n#endif|' lib/sigsegv.in.h
    sed -i 's|^# define HAVE_STACKVMA 1|#if !defined __wasm__\n# define HAVE_STACKVMA 1\n#endif|' lib/stackvma.h
    # stackvma.c selects its implementation directly on __linux__, ignoring the
    # header macro above; steer wasm to the file's generic "no way" #else stub.
    # && binds tighter than ||, so this reads (!wasm && linux) || android || ...,
    # which is false on wasm (no other OS macro is set) and unchanged elsewhere.
    sed -i 's~^#if defined __linux__ || defined __ANDROID__~#if !defined __wasm__ \&\& defined __linux__ || defined __ANDROID__~' lib/stackvma.c
  '';

  passthru.checks = {
    functionality = vm-test.vmTest {
      name = "diffutils-functionality";
      initramfs = vm-test.mkInitramfs {
        name = "diffutils-functionality";
        init = ./functionality-test.sh;
        # busybox first, diffutils last: the GNU binary must shadow busybox's applet.
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
