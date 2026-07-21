{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://www.lua.org/ftp/lua-5.4.8.tar.gz";
    hash = "sha256-6TMsVp2D3WtvnwyhvwodjQH3kvTXz1rSMWwiHazvKys=";
  },
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

  # Package outputs are overlaid at the guest root. Compile Lua's module search
  # paths for that runtime filesystem instead of its /usr/local default.
  postPatch = ''
    substituteInPlace src/luaconf.h \
      --replace-fail '"/usr/local/"' '"/usr/"'
  '';

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
    make install \
      INSTALL_TOP="$out" \
      INSTALL_LMOD="$out/usr/share/lua/5.4" \
      INSTALL_CMOD="$out/usr/lib/lua/5.4" \
      CC="$CC" AR="llvm-ar rcu" RANLIB="llvm-ranlib"
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
            files = {
              "/usr/share/lua/5.4/guest_test.lua" = builtins.toFile "guest-test.lua" ''
                return { answer = 42 }
              '';
            };
          };
        };
    in
    {
      language = check "language" ./language-test.sh;
    };
})
