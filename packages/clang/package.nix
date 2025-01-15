{
  fetch,
  run,

  clang,
  clang-tblgen,
  cmake,
  lld,
  llvm,
  sysroot,
  ninja,
  python3,
}:

run
  rec {
    name = "clang";
    # renovate: datasource=github-releases name=llvm/llvm-project
    version = "19.1.7";
    src = fetch.tar {
      url = "https://github.com/llvm/llvm-project/releases/download/llvmorg-${version}/llvm-project-${version}.src.tar.xz";
      hash = "sha256-gkAf6nt50AeAQ/dZi4NShNZlCnW5PmS292Hqe2MJdQE=";
    };
    path = [
      clang
      clang-tblgen
      cmake
      lld
      llvm
      ninja
      python3
    ];
  }
  ''
    (cd clang && patch -p1 <${./clang-add-wasm-linux-target.patch})
    patch -p1 <${./llvm-remove-mmap-fork.patch}

    cmake -S llvm -B build -G Ninja \
      -DWASM=ON \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-linux-musl \
      -DCMAKE_C_COMPILER_WORKS=ON \
      -DCMAKE_C_FLAGS="--sysroot=${sysroot}" \
      -DCMAKE_CXX_COMPILER_TARGET=wasm32-unknown-linux-musl \
      -DCMAKE_CXX_COMPILER_WORKS=ON \
      -DCMAKE_CXX_FLAGS="--sysroot=${sysroot} -stdlib=libc++" \
      -DCMAKE_INSTALL_PREFIX=$out \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=OFF \
      -DCMAKE_SKIP_BUILD_RPATH=ON \
      -DCMAKE_SKIP_INSTALL_RPATH=ON \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=lld --sysroot=${sysroot} -Wl,--allow-undefined" \
      -DCMAKE_SHARED_LINKER_FLAGS="-fuse-ld=lld --sysroot=${sysroot} -Wl,--allow-undefined" \
      -DCMAKE_SYSROOT=${sysroot} \
      -DDEFAULT_SYSROOT=${sysroot} \
      -DHAVE_LINK_VERSION_SCRIPT=0 \
      -DLLVM_ENABLE_PROJECTS=clang \
      -DLLVM_ENABLE_LIBCXX=ON \
      -DBUILD_SHARED_LIBS=OFF \
      -DLLVM_BUILD_LLVM_DYLIB=OFF \
      -DLLVM_LINK_LLVM_DYLIB=OFF \
      -DCLANG_LINK_CLANG_DYLIB=OFF \
      -DLIBCLANG_BUILD_STATIC=ON \
      -DLLVM_ENABLE_PIC=OFF \
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
      -DLLVM_TABLEGEN=${llvm}/bin/llvm-tblgen \
      -DLLVM_TABLEGEN_EXE=${llvm}/bin/llvm-tblgen \
      -DLLVM_NATIVE_TOOL_DIR=${llvm}/bin \
      -DLLVM_HOST_TRIPLE=wasm32-unknown-linux-musl \
      -DLLVM_TARGET_ARCH=wasm32 \
      -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
      -DLLVM_USE_LINKER=lld \
      -DLLVM_HAVE_LINK_VERSION_SCRIPT=0

    cmake --build build --target install -j$NIX_BUILD_CORES
    ln -s $out/bin/clang $out/bin/cc
    ln -s $out/bin/clang++ $out/bin/c++
  ''
