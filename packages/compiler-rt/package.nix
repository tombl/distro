{
  fetch,
  run,

  clang,
  cmake,
  lld,
  llvm,
  musl,
  ninja,
  python3,
}:

run
  {
    name = "compiler-rt";
    src = fetch.tar {
      url = "https://github.com/llvm/llvm-project/releases/download/llvmorg-19.1.7/llvm-project-19.1.7.src.tar.xz";
      hash = "sha256-cZAB5vZjeTsXt9QHbP5xluWNQnAHByHtHnAhVDV0E6I=";
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
    cmake -S compiler-rt -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
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
