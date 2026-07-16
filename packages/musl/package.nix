{
  run,
  lib,
  config,
  musl-src,

  clang-no-compiler-rt,
  gnumake,
  lld,
  llvm,
}:

run
  {
    name = "musl";
    src = musl-src;
    path = [
      clang-no-compiler-rt
      gnumake
      lld
      llvm
    ];
    # TODO: split for size, only relevant for dynamic linking
    # outputs = [ "out" "dev" ];
  }
  ''
    cat >config.mak <<EOF
    ARCH=wasm32
    prefix=$out
    syslibdir=$out
    CFLAGS=${lib.optionalString config.debug "-g"}
    EOF

    mkdir $out
    make -j$NIX_BUILD_CORES install-libs install-headers
  ''
