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
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=$out \
      -DLLVM_ENABLE_RUNTIMES="compiler-rt" \
      -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
      -DLLVM_USE_LINKER=lld

    cmake --build build --target install
  ''
