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
  rec {
    name = "clang";
    # renovate: datasource=github-releases name=llvm/llvm-project
    version = "19.1.6";
    src = fetch.tar {
      url = "https://github.com/llvm/llvm-project/releases/download/llvmorg-${version}/llvm-project-${version}.src.tar.xz";
      hash = "sha256-LD4nIjZTSZJtbgW6tZopbTF5Mq0Tenj2gbuPXhtOeUI=";
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
    (cd clang && patch -p1 <${./add-wasm-linux-target.patch})

    cmake -S llvm -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_FLAGS="-I${musl}/include --target=wasm32-linux" \
      -DCMAKE_CXX_FLAGS="-I${musl}/include --target=wasm32-linux" \
      -DCMAKE_INSTALL_PREFIX=$out \
      -DCMAKE_SYSTEM_NAME=Linux \
      -DLLVM_HOST_TRIPLE=wasm32-linux \
      -DLLVM_ENABLE_PROJECTS="clang;lldb" \
      -DLLVM_TARGET_ARCH=wasm32-linux \
      -DLLVM_TARGETS_TO_BUILD="WebAssembly"

    cmake --build build --target install -j$NIX_BUILD_CORES
  ''
