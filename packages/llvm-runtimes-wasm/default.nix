{
  pkgs,
  src,
}:

let
  inherit (pkgs.wasmpkgs) llvm-toolchain-host-unwrapped sysroot-base;
  llvm = import ../llvm-toolchain/common.nix { inherit (pkgs) lib; };
  wasmCompileFlags = "--sysroot=${sysroot-base} -matomics -mbulk-memory";

  cmakeFlags = [
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_SYSTEM_NAME=Linux"
    "-DCMAKE_SYSROOT=${sysroot-base}"
    "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY"
    "-DCMAKE_C_COMPILER=${llvm-toolchain-host-unwrapped}/bin/clang"
    "-DCMAKE_CXX_COMPILER=${llvm-toolchain-host-unwrapped}/bin/clang++"
    "-DCMAKE_AR=${llvm-toolchain-host-unwrapped}/bin/llvm-ar"
    "-DCMAKE_RANLIB=${llvm-toolchain-host-unwrapped}/bin/llvm-ranlib"
    "-DCMAKE_C_COMPILER_TARGET=${llvm.targetTriple}"
    "-DCMAKE_CXX_COMPILER_TARGET=${llvm.targetTriple}"
    "-DCMAKE_C_FLAGS=${wasmCompileFlags}"
    "-DCMAKE_CXX_FLAGS=${wasmCompileFlags}"
    "-DCMAKE_BUILD_WITH_INSTALL_RPATH=OFF"
    "-DCMAKE_SKIP_BUILD_RPATH=ON"
    "-DCMAKE_SKIP_INSTALL_RPATH=ON"
    "-DLLVM_ENABLE_RUNTIMES=compiler-rt;libcxx;libcxxabi"
    "-DLLVM_DEFAULT_TARGET_TRIPLE=${llvm.targetTriple}"
    "-DLLVM_BUILTIN_TARGETS=${llvm.targetTriple}"
    "-DLLVM_ENABLE_PER_TARGET_RUNTIME_DIR=ON"
    "-DLLVM_INCLUDE_TESTS=OFF"
    "-DLLVM_INCLUDE_DOCS=OFF"
    "-DLLVM_BUILD_TOOLS=OFF"
    "-DLLVM_USE_LINKER=lld"
    "-DCOMPILER_RT_BUILD_CRT=OFF"
    "-DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON"
    "-DLIBCXX_ENABLE_SHARED=OFF"
    "-DLIBCXX_HAS_MUSL_LIBC=ON"
    "-DLIBCXX_USE_COMPILER_RT=ON"
    "-DLIBCXXABI_ENABLE_SHARED=OFF"
    "-DLIBCXXABI_USE_COMPILER_RT=ON"
    "-DLIBCXXABI_USE_LLVM_UNWINDER=OFF"
  ];
in

pkgs.stdenvNoCC.mkDerivation {
  pname = "llvm-runtimes-wasm";
  inherit (llvm) version;
  inherit src;

  nativeBuildInputs = [
    pkgs.cmake
    pkgs.ninja
    pkgs.perl
    pkgs.python3
    llvm-toolchain-host-unwrapped
  ];

  postPatch = ''
    patch -p1 <${llvm.patches.compilerRtWasm}
  '';

  configurePhase = ''
    runHook preConfigure
    cmake -S runtimes -B build -G Ninja -DCMAKE_INSTALL_PREFIX="$out" ${pkgs.lib.escapeShellArgs cmakeFlags}
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    cmake --build build --target install -j$NIX_BUILD_CORES
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/clang/${llvm.majorVersion}/lib/${llvm.targetTriple} $out/lib/clang/${llvm.majorVersion}/lib/wasm32 $out/lib/clang/${llvm.majorVersion}/lib/wasm32-unknown
    cp $out/lib/${llvm.targetTriple}/libclang_rt.builtins.a $out/lib/clang/${llvm.majorVersion}/lib/${llvm.targetTriple}/libclang_rt.builtins.a
    cp $out/lib/${llvm.targetTriple}/libclang_rt.builtins.a $out/lib/clang/${llvm.majorVersion}/lib/wasm32/libclang_rt.builtins.a
    cp $out/lib/${llvm.targetTriple}/libclang_rt.builtins.a $out/lib/clang/${llvm.majorVersion}/lib/wasm32-unknown/libclang_rt.builtins.a
    runHook postInstall
  '';
}
