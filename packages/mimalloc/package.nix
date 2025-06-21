{
  fetch,
  run,
  config,

  clang,
  cmake,
  lld,
  ninja,
  musl,
}:

run
  {
    name = "mimalloc";
    version = "2.1.9";
    src = fetch.github {
      owner = "microsoft";
      repo = "mimalloc";
      rev = "refs/tags/v2.1.9";
      hash = "sha256-NEi6uayLoMvnwYwxp2JT1GItdKteiCTw9N+ctltMb5I=";
    };
    path = [
      clang
      cmake
      lld
      ninja
    ];
  }
  ''
    cmake -B build -G Ninja \
      -DCMAKE_C_COMPILER_TARGET=wasm32-unknown \
      -DCMAKE_CXX_COMPILER_TARGET=wasm32-unknown \
      -DCMAKE_C_COMPILER_WORKS=ON \
      -DCMAKE_CXX_COMPILER_WORKS=ON \
      -DCMAKE_C_FLAGS="-I${musl}/include" \
      -DCMAKE_CXX_FLAGS="-I${musl}/include" \
      -DCMAKE_INSTALL_PREFIX=$out \
      -DCMAKE_BUILD_TYPE=${if config.debug then "Debug" else "Release"}

    cmake --build build --target install -j$NIX_BUILD_CORES
  ''
