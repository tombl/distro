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
      rev = "314d4e81e26546ba063663437657095ad2c0351c";
      hash = "sha256-gCylldyaICorupH1e1eXD6fW8ILYeFkokMlMPz4UV5E=";
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
