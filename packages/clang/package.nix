{
  fetch,
  run,

  clang-no-wasm-libs,
  clang-tblgen,
  cmake,
  lld,
  llvm,
  libcxx,
  musl,
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
      clang-no-wasm-libs
      clang-tblgen
      cmake
      lld
      llvm
      ninja
      python3
      libcxx
    ];
  }
  ''
    # (cd clang && patch -p1 <${./add-wasm-linux-target.patch})

    if [ -n "''${CPLUS_INCLUDE_PATH-}" ]; then
      export CPLUS_INCLUDE_PATH=${libcxx}/include/c++/v1:${libcxx}/include:$CPLUS_INCLUDE_PATH
    else
      export CPLUS_INCLUDE_PATH=${libcxx}/include/c++/v1:${libcxx}/include
    fi
    if [ -n "''${CMAKE_INCLUDE_PATH-}" ]; then
      export CMAKE_INCLUDE_PATH=${libcxx}/include/c++/v1:${libcxx}/include:$CMAKE_INCLUDE_PATH
    else
      export CMAKE_INCLUDE_PATH=${libcxx}/include/c++/v1:${libcxx}/include
    fi
    if [ -n "''${LIBRARY_PATH-}" ]; then
      export LIBRARY_PATH=${libcxx}/lib:$LIBRARY_PATH
    else
      export LIBRARY_PATH=${libcxx}/lib
    fi
    if [ -n "''${CMAKE_LIBRARY_PATH-}" ]; then
      export CMAKE_LIBRARY_PATH=${libcxx}/lib:$CMAKE_LIBRARY_PATH
    else
      export CMAKE_LIBRARY_PATH=${libcxx}/lib
    fi

    cmake -S llvm -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_COMPILER_TARGET=wasm32-linux \
      -DCMAKE_C_COMPILER_WORKS=ON \
      -DCMAKE_CXX_COMPILER_TARGET=wasm32-linux \
      -DCMAKE_CXX_COMPILER_WORKS=ON \
      -DCMAKE_CXX_STANDARD_INCLUDE_DIRECTORIES=${libcxx}/include/c++/v1:${libcxx}/include \
      -DCMAKE_INSTALL_PREFIX=$out \
      -DCMAKE_SYSROOT=${musl}\
      -DCMAKE_SYSTEM_NAME=Linux \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=lld" \
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
      -DLLVM_USE_LINKER=lld \
      -DHAVE_MACHINE_ENDIAN_H=0

    cmake --build build --target install -j$NIX_BUILD_CORES
  ''
