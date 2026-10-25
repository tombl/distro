# libunwind for the wasm EH proposal. The sysroot's libc++abi is built without
# an unwinder, so any C++ program linking libc++ (iostream included) fails on
# undefined _Unwind_* symbols. On wasm the unwinder is only a thin shim over the
# throw instruction.
#
# Built separately rather than in llvm-runtimes so adding it to the SDK leaves
# the sysroot, and so every stdenv package, unchanged.
{
  pkgs,
  platform,
  llvm-runtimes,
  llvm-toolchain-unwrapped,
  sysroot-base,
}:

let
  wasmCompileFlags = "--sysroot=${sysroot-base} ${toString platform.compilerFlags}";
in

pkgs.stdenvNoCC.mkDerivation {
  pname = "libunwind";
  inherit (llvm-toolchain-unwrapped) version;
  inherit (llvm-runtimes) src;

  nativeBuildInputs = [
    pkgs.cmake
    pkgs.ninja
    pkgs.python3
    llvm-toolchain-unwrapped
  ];

  dontUseCmakeConfigure = true;

  # LIBUNWIND_HIDE_SYMBOLS: wasm is neither ELF nor Mach-O, so libunwind's
  # export macro otherwise falls back to __declspec(dllexport).
  buildPhase = ''
    runHook preBuild
    cmake -S runtimes -B build -G Ninja -DCMAKE_INSTALL_PREFIX="$out" \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_SYSTEM_NAME=Linux \
      -DCMAKE_SYSROOT=${sysroot-base} \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DCMAKE_C_COMPILER=${llvm-toolchain-unwrapped}/bin/clang \
      -DCMAKE_CXX_COMPILER=${llvm-toolchain-unwrapped}/bin/clang++ \
      -DCMAKE_ASM_COMPILER=${llvm-toolchain-unwrapped}/bin/clang \
      -DCMAKE_AR=${llvm-toolchain-unwrapped}/bin/llvm-ar \
      -DCMAKE_RANLIB=${llvm-toolchain-unwrapped}/bin/llvm-ranlib \
      -DCMAKE_C_COMPILER_TARGET=${platform.targetTriple} \
      -DCMAKE_CXX_COMPILER_TARGET=${platform.targetTriple} \
      -DCMAKE_ASM_COMPILER_TARGET=${platform.targetTriple} \
      "-DCMAKE_C_FLAGS=${wasmCompileFlags}" \
      "-DCMAKE_CXX_FLAGS=${wasmCompileFlags}" \
      -DLLVM_ENABLE_RUNTIMES=libunwind \
      -DLLVM_INCLUDE_TESTS=OFF \
      -DLLVM_INCLUDE_DOCS=OFF \
      -DLIBUNWIND_ENABLE_SHARED=OFF \
      -DLIBUNWIND_USE_COMPILER_RT=ON \
      -DLIBUNWIND_INCLUDE_TESTS=OFF \
      -DLIBUNWIND_HIDE_SYMBOLS=ON
    cmake --build build --target install -j$NIX_BUILD_CORES
    runHook postBuild
  '';

  dontInstall = true;
}
