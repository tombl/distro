{
  stdenv,
  src,
  vm-test,
  busybox,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "lua";
  version = "5.4.8";
  inherit src;

  # Lua's error propagation and coroutine yield unwind with _setjmp/_longjmp;
  # on wasm those only work in code compiled with the SjLj lowering.
  env.NIX_CFLAGS_COMPILE = "-mllvm -wasm-enable-sjlj";

  # The plain Makefile hardcodes gcc/ar/ranlib; point them at the wasm
  # toolchain. The `posix` target enables POSIX libc features without
  # LUA_USE_DLOPEN, so package.loadlib compiles but fails gracefully at runtime
  # rather than requiring dlopen, which the platform does not provide.
  buildPhase = ''
    runHook preBuild
    make -j$NIX_BUILD_CORES posix CC="$CC" AR="llvm-ar rcu" RANLIB="llvm-ranlib"
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    make install INSTALL_TOP="$out" CC="$CC" AR="llvm-ar rcu" RANLIB="llvm-ranlib"
    runHook postInstall
  '';

  passthru.checks =
    let
      check =
        name: init:
        vm-test.vmTest {
          name = "lua-${name}";
          initramfs = vm-test.mkInitramfs {
            name = "lua-${name}";
            inherit init;
            contents = [
              finalAttrs.finalPackage
              busybox
            ];
          };
        };
    in
    {
      language = check "language" ./language-test.sh;
    };
})
