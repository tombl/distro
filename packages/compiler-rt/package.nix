{
  fetch,
  run,
  config,

  clang,
  cmake,
  lld,
  llvm,
  musl,
  ninja,
  python3,
}:

run
  rec {
    name = "compiler-rt";
    # renovate: datasource=github-releases name=llvm/llvm-project
    version = "19.1.6";
    src = fetch.tar {
      url = "https://github.com/llvm/llvm-project/releases/download/llvmorg-${version}/llvm-project-${version}.src.tar.xz";
      hash = "sha256-4/eTF62qkZbSz//hyGnXwQC3VAgyvET+DT9EoShh+jQ=";
    };
    path = [
      clang
      cmake
      lld
      llvm
      ninja
      python3
    ];
  }
  ''
    patch -p1 <${./wasm.patch}

    cmake -S compiler-rt -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=${if config.debug then "Debug" else "Release"} \
      -DCMAKE_CXX_COMPILER_TARGET=wasm32-unknown \
      -DCMAKE_CXX_COMPILER_WORKS=ON \
      -DCMAKE_CXX_FLAGS="-I${musl}/include" \
      -DCMAKE_C_COMPILER_TARGET=wasm32-unknown \
      -DCMAKE_C_COMPILER_WORKS=ON \
      -DCMAKE_C_FLAGS="-I${musl}/include" \
      -DCOMPILER_RT_BUILD_CRT=false \
      -DCOMPILER_RT_DEFAULT_TARGET_ARCH=wasm32-unknown \
      -DCOMPILER_RT_DEFAULT_TARGET_ONLY=true

    cmake --build build -j$NIX_BUILD_CORES

    mkdir $out
    cp build/lib/*/libclang_rt.builtins-wasm32.a $out/
  ''
