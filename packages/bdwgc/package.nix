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
  libatomic_ops,

}:

run
  rec {
    name = "bdwgc";

    version = "8.2.10";
    src = fetch.github {
      owner = "bdwgc";
      repo = "bdwgc";
      rev = "98a8fc3b0c2c2c631fc6217e15d0123f097c21cb";

      hash = "sha256-FbdAXzPpMJUDn7JzpIYLN6cmYInaDq1Nin3m6cnXXyw=";
    };
    path = [
      clang
      gnumake
      lld
      llvm
    ];
  }
  ''
    ls
    patch -p1 <${./linux-wasm.patch}
    export CC_FOR_BUILD=${clang-host}/bin/clang
    export CC=${clang}/bin/clang
    export CFLAGS="--target=wasm32-unknown-linux-musl --sysroot=${sysroot} ${lib.optionalString config.debug "-g"} -matomics -mbulk-memory -I${libatomic_ops}/include"
    export LD=wasm-ld
    export LDFLAGS="--target=wasm32-unknown-linux-musl --sysroot=${sysroot} -fuse-ld=lld"
    export AR=llvm-ar

    ./configure --host=wasm32-unknown-linux-musl --prefix=$out

    make -j$NIX_BUILD_CORES install

  ''
