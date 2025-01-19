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
      hash = "sha256-3W/C6KOSoQmEqU3jIvp/Odo8AO87Kwl/5Q24FEJG2l8=";
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
    EOF

    mkdir $out
    make -j$NIX_BUILD_CORES install-libs install-headers
  ''
