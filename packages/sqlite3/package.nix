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
  clang-host,
}:

let
  archiveVersion =
    version:
    let
      fragments = lib.splitVersion version;
      major = lib.head fragments;
      minor = lib.concatMapStrings (lib.fixedWidthNumber 2) (lib.tail fragments);
    in
    major + minor + "00";
in

run
  rec {
    name = "sqlite3";
    version = "3.51.0";

    src = fetch.tar {
      url = "https://sqlite.org/2025/sqlite-autoconf-${archiveVersion version}.tar.gz";
      hash = "sha256-QuJt/dlqouaxsb5ciLCIf5lZCT9lDWk8sC65w20UbKU=";
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
    export CFLAGS="--target=wasm32-unknown-linux-musl --sysroot=${sysroot} ${lib.optionalString config.debug "-g"} -matomics -mbulk-memory -DSQLITE_OMIT_WAL=1 -DSQLITE_MAX_MMAP_SIZE=0"
    export LD=wasm-ld
    export LDFLAGS="--target=wasm32-unknown-linux-musl --sysroot=${sysroot} -fuse-ld=lld"
    export AR=llvm-ar

    ./configure --host=wasm32-unknown-linux-musl --prefix=$out
    make -j$NIX_BUILD_CORES install
  ''
