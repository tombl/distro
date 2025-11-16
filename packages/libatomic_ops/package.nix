{
  fetch,
  run,

  clang,
  clang-host,
  lib,
  lld,
  llvm,
  sysroot,
  config,
  gnumake,

}:

run
  rec {
    name = "libatomic_ops";

    version = "7.8.4";
    src = fetch.tar {
      url = "https://github.com/bdwgc/libatomic_ops/releases/download/v${version}/libatomic_ops-${version}.tar.gz";

      hash = "sha256-I1bgAugO9pWHXpcdak/YxhylxvpP0b8xzOVKJpyL/NU=";
    };
    path = [
      clang
      gnumake
      lld
      llvm
    ];
  }
  ''
    export CC_FOR_BUILD=${clang-host}/bin/clang
    export CC=${clang}/bin/clang
    export CFLAGS="--target=wasm32-unknown-linux-musl --sysroot=${sysroot} ${lib.optionalString config.debug "-g"} -matomics -mbulk-memory -DDONT_USE_MMAP"
    export LD=wasm-ld
    export LDFLAGS="--target=wasm32-unknown-linux-musl --sysroot=${sysroot} -fuse-ld=lld"
    export AR=llvm-ar

    ./configure --host=wasm32-unknown-linux-musl --prefix=$out

    make -j$NIX_BUILD_CORES install

  ''
