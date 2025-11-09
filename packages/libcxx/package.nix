{
  fetch,
  run,
  config,

  clang,
  cmake,
  lld,
  linux,
  llvm,
  musl,
  ninja,
  python3,
}:

run
  rec {
    name = "libcxx";
    # renovate: datasource=github-releases name=llvm/llvm-project
    version = "19.1.7";
    src = fetch.tar {
      url = "https://github.com/llvm/llvm-project/releases/download/llvmorg-${version}/llvm-project-${version}.src.tar.xz";
      hash = "sha256-gkAf6nt50AeAQ/dZi4NShNZlCnW5PmS292Hqe2MJdQE=";
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
    cmake -S runtimes -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=${if config.debug then "Debug" else "Release"} \
      -DCMAKE_INSTALL_PREFIX=$out \
      -DCMAKE_SYSROOT=${musl} \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-linux-musl \
      -DCMAKE_C_FLAGS="-I${linux.headers}/include" \
      -DCMAKE_CXX_COMPILER_TARGET=wasm32-unknown-linux-musl \
      -DCMAKE_CXX_FLAGS="-I${linux.headers}/include" \
      -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi" \
      -DLIBCXX_ENABLE_SHARED=OFF \
      -DLIBCXX_HAS_MUSL_LIBC=ON \
      -DLIBCXX_USE_COMPILER_RT=ON \
      -DLIBCXXABI_ENABLE_SHARED=OFF \
      -DLIBCXXABI_USE_LLVM_UNWINDER=OFF

    cmake --build build --target install -j$NIX_BUILD_CORES
  ''
