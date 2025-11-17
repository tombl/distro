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
      rev = "4f84c4dfeb2ebcaf9e7f1c85ae0240f07bf4441d";
      hash = "sha256-LekMVlVo9I5SSh8pWjvUNmsQNBfZ6OlCEbbeZKw99p8=";
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
