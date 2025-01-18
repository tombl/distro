{
  fetch,
  run,

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
      hash = "sha256-cZX+YcBL7O1TwZU+/vvD9zDE6r9Kwl4cZL3LRq5twGg=";
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
    ls

    cat >config.mak <<EOF
    ARCH=wasm32
    prefix=$out
    syslibdir=$out
    EOF

    mkdir $out
    make -j$NIX_BUILD_CORES install-libs install-headers
  ''
