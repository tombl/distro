{
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
    src = fetchGit {
      url = "https://github.com/llvm/llvm-project.git";
      ref = "refs/tags/llvmorg-${version}";
      rev = "e21dc4bd5474d04b8e62d7331362edcc5648d7e5";
      shallow = true;
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
