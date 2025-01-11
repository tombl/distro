{
  inputs,
  run,

  clang,
  gnumake,
  lld,
  llvm,
}:

run
  {
    name = "musl";
    src = inputs.musl;
    path = [
      clang
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
    EOF

    mkdir $out
    make -j$NIX_BUILD_CORES install-libs install-headers
  ''
