# clang, lld, and llvm tools built to run inside wasm Linux. Cross-compiling
# LLVM needs explicit cmake wiring against the build-platform toolchain, so
# this does not use the wasm stdenv.
{
  pkgs,
  lib,
  debug,
  platform,
  src,
  llvm-runtimes,
  llvm-toolchain,
  sysroot,
}:

let
  wasmCompileFlags = "--sysroot=${sysroot} ${toString platform.compilerFlags}";
  wasmLinkerFlags = "-fuse-ld=lld --sysroot=${sysroot} -Wl,--allow-undefined";

  buildModeFlags = [
    "-DWASM=ON"
    "-DCMAKE_BUILD_TYPE=${if debug then "Debug" else "Release"}"
  ];

  crossCompileFlags = [
    "-DCMAKE_C_COMPILER=${llvm-toolchain}/bin/clang"
    "-DCMAKE_CXX_COMPILER=${llvm-toolchain}/bin/clang++"
    "-DCMAKE_AR=${llvm-toolchain}/bin/llvm-ar"
    "-DCMAKE_RANLIB=${llvm-toolchain}/bin/llvm-ranlib"
    "-DCMAKE_C_COMPILER_TARGET=${platform.targetTriple}"
    "-DCMAKE_CXX_COMPILER_TARGET=${platform.targetTriple}"
    "-DCMAKE_C_COMPILER_WORKS=ON"
    "-DCMAKE_CXX_COMPILER_WORKS=ON"
    "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY"
    "-DCMAKE_SYSROOT=${sysroot}"
    "-DDEFAULT_SYSROOT=$out"
    "-DCMAKE_C_FLAGS=${wasmCompileFlags}"
    "-DCMAKE_CXX_FLAGS=${wasmCompileFlags} -stdlib=libc++"
    "-DCMAKE_EXE_LINKER_FLAGS=${wasmLinkerFlags}"
    "-DCMAKE_SHARED_LINKER_FLAGS=${wasmLinkerFlags}"
    "-DCMAKE_BUILD_WITH_INSTALL_RPATH=OFF"
    "-DCMAKE_SKIP_BUILD_RPATH=ON"
    "-DCMAKE_SKIP_INSTALL_RPATH=ON"
  ];

  llvmBuildFlags = [
    "-DLLVM_ENABLE_PROJECTS=clang;lld"
    "-DLLVM_ENABLE_RUNTIMES="
    "-DLLVM_ENABLE_LIBCXX=ON"
    "-DLLVM_HOST_TRIPLE=${platform.targetTriple}"
    "-DLLVM_TARGET_ARCH=wasm32"
    "-DLLVM_TARGETS_TO_BUILD=WebAssembly"
    "-DBUILD_SHARED_LIBS=OFF"
    "-DLLVM_BUILD_LLVM_DYLIB=OFF"
    "-DLLVM_LINK_LLVM_DYLIB=OFF"
    "-DCLANG_LINK_CLANG_DYLIB=OFF"
    "-DLIBCLANG_BUILD_STATIC=ON"
    "-DLLVM_ENABLE_PIC=OFF"
    "-DLLVM_INCLUDE_BENCHMARKS=OFF"
    "-DLLVM_INCLUDE_TESTS=OFF"
    "-DLLVM_INCLUDE_DOCS=OFF"
    "-DLLVM_BUILD_UTILS=OFF"
    "-DLLVM_TOOL_LLVM_EXEGESIS_BUILD=OFF"
    "-DLLVM_INSTALL_TOOLCHAIN_ONLY=ON"
    "-DLLVM_INSTALL_BINUTILS_SYMLINKS=OFF"
    "-DLLVM_TOOLCHAIN_TOOLS=not-a-real-tool"
    "-DCLANG_INCLUDE_TESTS=OFF"
    "-DCLANG_INCLUDE_DOCS=OFF"
    "-DCLANG_ENABLE_ARCMT=OFF"
    "-DCLANG_ENABLE_STATIC_ANALYZER=OFF"
    "-DCLANG_TOOL_LIBCLANG_BUILD=OFF"
    "-DCLANG_TOOL_C_INDEX_TEST_BUILD=OFF"
    "-DCLANG_TOOL_CLANG_FORMAT_BUILD=OFF"
    "-DCLANG_TOOL_CLANG_REFACTOR_BUILD=OFF"
    "-DCLANG_TOOL_CLANG_RENAME_BUILD=OFF"
    "-DCLANG_TOOL_CLANG_SCAN_DEPS_BUILD=OFF"
    "-DLLD_SYMLINKS_TO_CREATE=wasm-ld"
    "-DLLVM_USE_LINKER=lld"
    "-DCLANG_DEFAULT_RTLIB=compiler-rt"
    "-DCLANG_DEFAULT_CXX_STDLIB=libc++"
    "-DCLANG_DEFAULT_LINKER=lld"
  ];

  nativeToolFlags = [
    "-DCLANG_TABLEGEN=${llvm-toolchain}/bin/clang-tblgen"
    "-DCLANG_TABLEGEN_EXE=${llvm-toolchain}/bin/clang-tblgen"
    "-DLLVM_TABLEGEN=${llvm-toolchain}/bin/llvm-tblgen"
    "-DLLVM_TABLEGEN_EXE=${llvm-toolchain}/bin/llvm-tblgen"
    "-DLLVM_NATIVE_TOOL_DIR=${llvm-toolchain}/bin"
  ];

  targetCmakeFlags = buildModeFlags ++ crossCompileFlags ++ llvmBuildFlags ++ nativeToolFlags;
in

pkgs.stdenvNoCC.mkDerivation {
  name = "clang";
  version = "19.1.7";
  inherit src;

  nativeBuildInputs = [
    llvm-toolchain
    pkgs.cmake
    pkgs.ninja
    pkgs.python3
  ];

  configurePhase = ''
    runHook preConfigure
    cmake -S llvm -B build -G Ninja -DCMAKE_INSTALL_PREFIX=$out ${lib.escapeShellArgs targetCmakeFlags}
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild

    cmake --build build --target install -j$NIX_BUILD_CORES

    mkdir -p $out/include/${platform.multiarchTriple} $out/lib/clang/19/lib/${platform.targetTriple} $out/lib/clang/19/lib/wasm32 $out/lib/clang/19/lib/wasm32-unknown $out/share
    cp -r ${sysroot}/include/c++ $out/include/
    cp -r ${sysroot}/include/${platform.multiarchTriple}/c++ $out/include/${platform.multiarchTriple}/
    cp -r ${sysroot}/share/libc++ $out/share/
    cp ${sysroot}/lib/libc++.a $out/lib/
    cp ${sysroot}/lib/libc++abi.a $out/lib/
    cp ${sysroot}/lib/libc++experimental.a $out/lib/
    cp ${llvm-runtimes}/lib/clang/19/lib/${platform.targetTriple}/libclang_rt.builtins.a $out/lib/clang/19/lib/${platform.targetTriple}/
    cp $out/lib/clang/19/lib/${platform.targetTriple}/libclang_rt.builtins.a $out/lib/clang/19/lib/wasm32/libclang_rt.builtins.a
    cp $out/lib/clang/19/lib/${platform.targetTriple}/libclang_rt.builtins.a $out/lib/clang/19/lib/wasm32-unknown/libclang_rt.builtins.a

    ln -sf clang $out/bin/cc
    ln -sf clang++ $out/bin/c++
    ln -sf wasm-ld $out/bin/ld

    runHook postBuild
  '';

  installPhase = "runHook preInstall; runHook postInstall";
}
