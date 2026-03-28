{
  fetch,
  run,
  lib,
  config,

  clang,
  gnumake,
  lld,
  llvm,
  musl,
  perl,
}:

run
  {
    name = "openssl";
    src = fetch.tar {
      url = "https://github.com/openssl/openssl/releases/download/openssl-3.5.4/openssl-3.5.4.tar.gz";
      hash = "sha256-lnMR+ElVMWlpvbHY1LmDcY70IzhjnGIexMNP3e81Xpk=";
    };
    path = [
      clang
      gnumake
      lld
      llvm
      perl
    ];
    outputs = [
      "out"
      "dev"
    ];
  }
  ''
    # OpenSSL configuration for wasm32-unknown (WebAssembly)
    export CC="${clang}/bin/clang --target=wasm32 -nostdlib -isystem ${musl}/include -matomics -mbulk-memory"
    export AR=${llvm}/bin/llvm-ar
    export RANLIB=${llvm}/bin/llvm-ranlib
    export CFLAGS="${lib.optionalString config.debug "-g"}"

    perl ./Configure \
      --prefix=$out \
      --openssldir=$out \
      --with-rand-seed=getrandom \
      no-asm \
      no-shared \
      no-dso \
      no-engine \
      no-hw \
      no-ui-console \
      no-apps \
      no-tests \
      linux-generic32

    # Build OpenSSL libraries only
    make -j$NIX_BUILD_CORES build_libs

    # Install to outputs
    make install_sw install_ssldirs

    # Create dev output with headers and pkg-config
    mkdir -p $dev/include $dev/lib/pkgconfig
    mv $out/include/* $dev/include/
    if [ -d $out/lib/pkgconfig ]; then
      mv $out/lib/pkgconfig/* $dev/lib/pkgconfig/
    fi

    # Keep static libraries in main output
    # Fix any references to point to correct outputs
    for pc in $dev/lib/pkgconfig/*.pc; do
      if [ -f "$pc" ]; then
        sed -i "s|$out|$dev|g" "$pc"
      fi
    done
  ''
