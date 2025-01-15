{
  fetch,
  run,

  clang-no-wasm-libs,
  clang-tblgen,
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
      clang-no-wasm-libs
      clang-tblgen
      cmake
      lld
      llvm
      ninja
      python3
    ];
  }
  ''
    patch -p1 <${./add-wasm-linux-target.patch}

    cmake -S llvm -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_COMPILER_TARGET=wasm32-unknown \
      -DCMAKE_CXX_COMPILER_TARGET=wasm32-unknown \
      -DCMAKE_INSTALL_PREFIX=$out \
      -DCMAKE_SYSROOT=${musl} \
      -DCMAKE_SYSTEM_NAME=Linux \
      -DLLVM_ENABLE_PROJECTS=clang \
      -DLLVM_ENABLE_LIBCXX=ON \
      -DLLVM_ENABLE_RUNTIMES="" \
      -DLLVM_INCLUDE_BENCHMARKS=OFF \
      -DLLVM_INCLUDE_TESTS=OFF \
      -DLLVM_INCLUDE_DOCS=OFF \
      -DLLVM_BUILD_UTILS=OFF \
      -DLLVM_TOOL_LLVM_EXEGESIS_BUILD=OFF \
      -DCLANG_INCLUDE_TESTS=OFF \
      -DCLANG_INCLUDE_DOCS=OFF \
      -DCLANG_TABLEGEN=${clang-tblgen}/bin/clang-tblgen \
      -DCLANG_TABLEGEN_EXE=${clang-tblgen}/bin/clang-tblgen \
      -DLLVM_NATIVE_TOOL_DIR=${llvm}/bin \
      -DLLVM_HOST_TRIPLE=wasm32-linux \
      -DLLVM_TARGET_ARCH=wasm32-linux \
      -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
      -DLLVM_USE_LINKER=lld

    cmake --build build --target install -j$NIX_BUILD_CORES
  ''
