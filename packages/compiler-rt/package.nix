{
  inputs,
  run,

  clang,
  cmake,
  lld,
  llvm,
  ninja,
  python3,
}:

run
  {
    name = "compiler-rt";
    src = inputs.llvm;
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
    cd llvm

    cmake -B build -G Ninja \
      -DCMAKE_C_COMPILER_WORKS=ON \
      -DCMAKE_CXX_COMPILER_WORKS=ON \
      -DCMAKE_BUILD_TYPE=Release \
      -DCOMPILER_RT_BAREMETAL_BUILD=On \
      -DCOMPILER_RT_BUILD_XRAY=OFF \
      -DCOMPILER_RT_INCLUDE_TESTS=OFF \
      -DCOMPILER_RT_HAS_FPIC_FLAG=OFF \
      -DCOMPILER_RT_ENABLE_IOS=OFF \
      -DCOMPILER_RT_DEFAULT_TARGET_ONLY=On \
      -DLLVM_CONFIG_PATH=$ROOT_DIR/build/llvm/bin/llvm-config \
      -DCMAKE_INSTALL_PREFIX=$out \
      -DCMAKE_VERBOSE_MAKEFILE:BOOL=ON \
      -DLLVM_ENABLE_RUNTIMES="compiler-rt" \
      -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
      -DLLVM_USE_LINKER=lld

    cmake --build build --target install
  ''
