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
  python3,
}:

run
  rec {
    name = "python";
    version = "3.14.0";
    src = fetch.tar {
      url = "https://www.python.org/ftp/python/${version}/Python-${version}.tgz";
      hash = "sha256-iNLaTu1C+ppfQv9YqLyJiIgb1sVH4pfkZoLCaHY4qFE=";
    };
    path = [
      clang
      gnumake
      lld
      llvm
    ];
  }
  ''
    patch -p1 <${./build.patch}

    export CONFIG_SITE=/dev/null
    export CFLAGS="--target=wasm32-unknown-linux-musl --sysroot=${sysroot} ${lib.optionalString config.debug "-g"} -matomics -mbulk-memory"
    export LDFLAGS="--target=wasm32-unknown-linux-musl -fuse-ld=lld --sysroot=${sysroot}"

    ./configure \
      --host=wasm32-unknown-linux-musl \
      --build=x86_64-linux-gnu \
      --with-build-python=${python3}/bin/python3 \
      --prefix=$out \
      --disable-shared \
      --without-pymalloc \
      --without-mimalloc \
      --without-doc-strings \
      --with-ensurepip=no \
      --disable-test-modules \
      --disable-ipv6 \
      --without-remote-debug \
      py_cv_module__remote_debugging=n/a \
      py_cv_module_mmap=n/a \
      py_cv_module__posixsubprocess=n/a \
      ac_cv_file__dev_ptmx=no \
      ac_cv_file__dev_ptc=no \
      ac_cv_posix_semaphores_enabled=no \
      AR=llvm-ar

    make -j$NIX_BUILD_CORES all build-details.json
    make install
  ''
