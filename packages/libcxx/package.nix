{
  fetch,
  run,
  config,

  clang-no-wasm-libs,
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
      clang-no-wasm-libs
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
      -DCMAKE_C_COMPILER_TARGET=wasm32-linux \
      -DCMAKE_C_COMPILER_WORKS=ON \
      -DCMAKE_C_FLAGS="-I${musl}/include -I${linux.headers}/include" \
      -DCMAKE_CXX_COMPILER_TARGET=wasm32-linux \
      -DCMAKE_CXX_COMPILER_WORKS=ON \
      -DCMAKE_CXX_FLAGS="-I${musl}/include -I${linux.headers}/include" \
      -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi;libunwind" \
      -DLLVM_ENABLE_PROJECTS="" \
      -DLLVM_HOST_TRIPLE=wasm32-linux \
      -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
      -DLIBCXX_ENABLE_FILESYSTEM=ON \
      -DLIBCXX_ENABLE_RTTI=ON \
      -DLIBCXX_ENABLE_SHARED=OFF \
      -DLIBCXX_ENABLE_STATIC=ON \
      -DLIBCXX_ENABLE_THREADS=ON \
      -DLIBCXX_HAS_PTHREAD_API=ON \
      -DLIBCXX_ENABLE_EXCEPTIONS=ON \
      -DLIBCXX_ENABLE_MONOTONIC_CLOCK=ON \
      -DLIBCXX_HAS_MUSL_LIBC=ON \
      -DLIBCXX_USE_COMPILER_RT=ON \
      -DLIBCXXABI_ENABLE_SHARED=OFF \
      -DLIBCXXABI_ENABLE_THREADS=ON \
      -DLIBCXXABI_HAS_PTHREAD_API=ON \
      -DLIBCXXABI_ENABLE_EXCEPTIONS=ON \
      -DLIBCXXABI_USE_COMPILER_RT=ON \
      -DLIBCXXABI_INSTALL_STATIC_LIBRARY=ON \
      -DLIBCXXABI_STATICALLY_LINK_UNWINDER_IN_SHARED_LIBRARY=OFF \
      -DLIBCXX_CXX_ABI=libcxxabi \
      -DLIBCXXABI_USE_LLVM_UNWINDER=ON \
      -DLIBUNWIND_ENABLE_SHARED=OFF \
      -DLIBUNWIND_ENABLE_STATIC=ON \
      -DLIBUNWIND_ENABLE_THREADS=ON \
      -DLIBUNWIND_HAS_PTHREAD_API=ON \
      -DLIBUNWIND_ENABLE_EXCEPTIONS=ON \
      -DLIBUNWIND_INSTALL_STATIC_LIBRARY=ON \
      -DLIBUNWIND_USE_COMPILER_RT=ON \
      -DLLVM_PATH=llvm

    cmake --build build --target install -j$NIX_BUILD_CORES
  ''
