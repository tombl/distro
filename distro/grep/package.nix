{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://ftp.gnu.org/gnu/grep/grep-3.11.tar.xz";
    hash = "sha256-e4F99gC1JWZEYiUmc7mlSjYdMrbBDxBjwdT4Wv/9oF4=";
  },
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "grep";
  version = "3.11";
  inherit src;

  configureFlags = [
    "--disable-nls"
  ];

  # gnulib's libsigsegv treats every __linux__ target as able to catch SIGSEGV
  # and recover from stack overflow, then compiles stackvma.c/sigsegv.c against
  # mmap, munmap, and mincore to locate the faulting stack VMA. wasm has none of
  # those, no memory protection, and never delivers SIGSEGV, so this machinery
  # cannot exist here. Exclude __wasm__ from the three capability macros; grep's
  # only use is a nice-to-have c_stack_action() diagnostic that becomes a no-op.
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
      name = "grep-functionality";
      initramfs = vm-test.mkInitramfs {
        name = "grep-functionality";
        init = ./functionality-test.sh;
        # busybox first, grep last: the GNU binary must shadow busybox's applet.
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
