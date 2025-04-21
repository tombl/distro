{
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
    src = fetchGit {
      url = "https://github.com/tombl/musl.git";
      rev = "96a1dc5522e66e9f42f5e9715f272a4628bd8d23";
      ref = "master";
      hash = "sha256-IjDa2VkS8wMnDWPXPDnsqEh8TNgSm7qZ0/F51WqPoUs=";
      shallow = true;
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
