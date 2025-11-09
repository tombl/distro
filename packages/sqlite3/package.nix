{
  fetch,
  run,
  lib,
  config,
  clang,
  sysroot,
  gnumake,
  lld,
  llvm,
}:
let
  archiveVersion = import ./archive-version.nix lib;
in
run
  rec {
    name = "sqlite3";
    version = "3.50.4";

    src = fetch.tar {
      url = "https://sqlite.org/2025/sqlite-autoconf-${archiveVersion version}.tar.gz";
      hash = "sha256-o9tYehuS7l3awvZrPttBsm+chnJ1eC1Gw6CIl31qWxg=";
    };

    path = [
      clang
      gnumake
      lld
      llvm
    ];
  }
  ''
       export CC=${clang}/bin/clang

       export CFLAGS=" --target=wasm32-unknown-linux-musl --sysroot=${sysroot} ${lib.optionalString config.debug "-g"} -matomics -mbulk-memory -DSQLITE_OS_OTHER=1  -I${sysroot}/include -L${sysroot}/lib"
    p
       export LDFLAGS="-v --target=wasm32-unknown-linux-musl --sysroot=${sysroot} -fuse-ld=lld"

       ./configure -v \
         --host=wasm32-unknown-linux-musl \
         --build=x86_64-linux-gnu \
         --prefix=$out \
         exec_prefix=${sysroot} \
      -fuse-ld=lld \
         AR=llvm-ar \
         --disable-shared \



       make -j$NIX_BUILD_CORES sqlite3
  ''
