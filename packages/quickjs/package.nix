{
  stdenv,
  src,
  vm-test,
  busybox,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "quickjs";
  version = "0.15.1";
  inherit src;

  # quickjs-ng over Bellard's quickjs: it is actively maintained and ships the
  # pre-generated gen/repl.c and gen/standalone.c in the release, so the qjs CLI
  # builds without ever running qjsc on the build host. That removes the only
  # real cross-compilation hazard (build-time JS->C codegen needing a native
  # engine, the way busybox/sqlite need depsBuildBuild), so no native quickjs is
  # required here.
  #
  # Upstream builds with CMake, but the source set is tiny -- the engine is four
  # .c files, cutils/list/dtoa are header-only, and the CLI just adds the two
  # generated sources -- so a direct cross compile is clearer than wiring up a
  # CMake toolchain file. -D_GNU_SOURCE is the only compile define CMake adds for
  # the engine. QuickJS's own exceptions are return-value based (it does not use
  # setjmp/longjmp), so unlike lua this needs no -mllvm -wasm-enable-sjlj. Its JS
  # stack limit is derived from __builtin_frame_address (the wasm shadow-stack
  # pointer) against a 1 MiB default, comfortably inside the 8 MiB shadow stack,
  # so recursion limits behave without tuning. os.Worker uses threads, which the
  # platform supports. Upstream's pthread wrapper type-puns its void-returning
  # callback into pthread's pointer-returning callback type. wasm function
  # tables enforce exact signatures, so a small typed trampoline bridges the
  # callback and returns NULL normally.
  #
  # os.exec uses posix_spawn on wasm: file actions cover stdio, closefrom, and
  # cwd, while uid/gid/groups fail explicitly because spawn cannot express
  # arbitrary credential changes. This preserves both blocking and asynchronous
  # process execution without requiring fork().
  patches = [
    ./wasm-posix-spawn.patch
    ./worker-pthread-trampoline.patch
  ];

  dontConfigure = true;

  # The engine sources plus the libc; the CLI adds the two generated modules and
  # qjs.c. qjsc.c is the bytecode compiler; built here as a guest binary too (it
  # links against the same objects and needs no host engine). -lm is a no-op
  # archive on musl but kept to mirror upstream's link line.
  buildPhase = ''
    runHook preBuild
    engine="dtoa.c libregexp.c libunicode.c quickjs.c quickjs-libc.c"
    $CC -D_GNU_SOURCE -O2 -I. -o qjs $engine gen/repl.c gen/standalone.c qjs.c -lm
    $CC -D_GNU_SOURCE -O2 -I. -o qjsc $engine qjsc.c -lm
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/include
    cp qjs qjsc $out/bin/
    cp quickjs.h quickjs-libc.h $out/include/
    runHook postInstall
  '';

  passthru.checks = {
    language = vm-test.vmTest {
      name = "quickjs-language";
      initramfs = vm-test.mkInitramfs {
        name = "quickjs-language";
        init = ./language-test.sh;
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
