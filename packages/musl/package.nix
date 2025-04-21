{
  fetch,
  run,
  lib,
  config,

  clang,
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
      rev = "refs/heads/master";
      hash = "sha256-BM/EVYa7nokGXQeh8rQsCM7vLGWfqTD3TmD+GZI8kzc=";
    };
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
    CFLAGS=${lib.optionalString config.debug "-g"}
    EOF

    mkdir $out
    make -j$NIX_BUILD_CORES install-libs install-headers
  ''
