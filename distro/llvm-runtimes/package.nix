# compiler-rt builtins, libc++, and libc++abi cross-compiled for wasm.
{
  pkgs,
  lib,
  platform,
  src ? pkgs.fetchFromGitHub {
    owner = "tombl";
    repo = "llvm-project";
    rev = "9aaceb42fef4f924a00126e0d66140d01482921c";
    hash = "sha256-UXfcTGqVJsIVQHDSSF2tcRuM7zysJycaEsmCmlepVVM=";
  },
  llvm-toolchain-unwrapped,
  sysroot-base,
}:

let
  llvmMajorVersion = lib.versions.major llvm-toolchain-unwrapped.version;
  wasmCompileFlags = "--sysroot=${sysroot-base} ${toString platform.compilerFlags}";

  cmakeFlags = [
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_SYSTEM_NAME=Linux"
    "-DCMAKE_SYSROOT=${sysroot-base}"
    "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY"
    "-DCMAKE_C_COMPILER=${llvm-toolchain-unwrapped}/bin/clang"
    "-DCMAKE_CXX_COMPILER=${llvm-toolchain-unwrapped}/bin/clang++"
    "-DCMAKE_ASM_COMPILER=${llvm-toolchain-unwrapped}/bin/clang"
    "-DCMAKE_AR=${llvm-toolchain-unwrapped}/bin/llvm-ar"
    "-DCMAKE_RANLIB=${llvm-toolchain-unwrapped}/bin/llvm-ranlib"
    "-DCMAKE_C_COMPILER_TARGET=${platform.targetTriple}"
    "-DCMAKE_CXX_COMPILER_TARGET=${platform.targetTriple}"
    "-DCMAKE_ASM_COMPILER_TARGET=${platform.targetTriple}"
    "-DCMAKE_C_FLAGS=${wasmCompileFlags}"
    "-DCMAKE_CXX_FLAGS=${wasmCompileFlags}"
    "-DCMAKE_ASM_FLAGS=-mexception-handling"
    "-DCMAKE_BUILD_WITH_INSTALL_RPATH=OFF"
    "-DCMAKE_SKIP_BUILD_RPATH=ON"
    "-DCMAKE_SKIP_INSTALL_RPATH=ON"
    "-DLLVM_ENABLE_RUNTIMES=compiler-rt;libcxx;libcxxabi"
    "-DLLVM_DEFAULT_TARGET_TRIPLE=${platform.targetTriple}"
    "-DLLVM_BUILTIN_TARGETS=${platform.targetTriple}"
    "-DLLVM_ENABLE_PER_TARGET_RUNTIME_DIR=ON"
    "-DLLVM_INCLUDE_TESTS=OFF"
    "-DLLVM_INCLUDE_DOCS=OFF"
    "-DLLVM_BUILD_TOOLS=OFF"
    "-DLLVM_USE_LINKER=lld"
    "-DCOMPILER_RT_BUILD_CTX_PROFILE=OFF"
    "-DCOMPILER_RT_BUILD_CRT=OFF"
    "-DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON"
    "-DCOMPILER_RT_BUILD_LIBFUZZER=OFF"
    "-DCOMPILER_RT_BUILD_MEMPROF=OFF"
    "-DCOMPILER_RT_BUILD_ORC=OFF"
    "-DCOMPILER_RT_BUILD_PROFILE=OFF"
    "-DCOMPILER_RT_BUILD_SANITIZERS=OFF"
    "-DCOMPILER_RT_BUILD_XRAY=OFF"
    "-DLIBCXX_ENABLE_SHARED=OFF"
    "-DLIBCXX_HAS_MUSL_LIBC=ON"
    "-DLIBCXX_USE_COMPILER_RT=ON"
    "-DLIBCXXABI_ENABLE_SHARED=OFF"
    "-DLIBCXXABI_USE_COMPILER_RT=ON"
    "-DLIBCXXABI_USE_LLVM_UNWINDER=OFF"
  ];
in

pkgs.stdenvNoCC.mkDerivation {
  pname = "llvm-runtimes";
  inherit (llvm-toolchain-unwrapped) version;
  inherit src;

  nativeBuildInputs = [
    pkgs.cmake
    pkgs.ninja
    pkgs.perl
    pkgs.python3
    llvm-toolchain-unwrapped
  ];

  configurePhase = ''
    runHook preConfigure
    cmake -S runtimes -B build -G Ninja -DCMAKE_INSTALL_PREFIX="$out" ${lib.escapeShellArgs cmakeFlags}
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    cmake --build build --target install -j$NIX_BUILD_CORES
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/clang/${llvmMajorVersion}/lib/${platform.targetTriple} $out/lib/clang/${llvmMajorVersion}/lib/wasm32 $out/lib/clang/${llvmMajorVersion}/lib/wasm32-unknown
    cp $out/lib/${platform.targetTriple}/libclang_rt.builtins.a $out/lib/clang/${llvmMajorVersion}/lib/${platform.targetTriple}/libclang_rt.builtins.a
    cp $out/lib/${platform.targetTriple}/libclang_rt.builtins.a $out/lib/clang/${llvmMajorVersion}/lib/wasm32/libclang_rt.builtins.a
    cp $out/lib/${platform.targetTriple}/libclang_rt.builtins.a $out/lib/clang/${llvmMajorVersion}/lib/wasm32-unknown/libclang_rt.builtins.a
    runHook postInstall
  '';
}
