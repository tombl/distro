{
  fetch,
  run,
  lib,
  config,

  clang-no-compiler-rt,
  gnumake,
  lld,
  llvm,
}:

run
  {
    name = "musl";
    src = fetch.github {
      owner = "tombl";
      repo = "musl";
      rev = "1b9248e905e8a0e59123365401266d6685c87b28";
      hash = "sha256-bzCx65NT6ojmNFsva+T7GRpVTyNTfNH0nN8s0Oh8zK0=";
    };
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
