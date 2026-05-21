{
  pkgs,
  src,
}:

let
  llvm = import ../llvm-toolchain/common.nix { inherit (pkgs) lib; };
  nativeTarget =
    if pkgs.stdenv.hostPlatform.isx86_64 then
      "X86"
    else if pkgs.stdenv.hostPlatform.isAarch64 then
      "AArch64"
    else
      throw "unsupported LLVM host target: ${pkgs.stdenv.hostPlatform.config}";

  cmakeFlags = [
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_C_COMPILER=${pkgs.llvmPackages_19.clang}/bin/clang"
    "-DCMAKE_CXX_COMPILER=${pkgs.llvmPackages_19.clang}/bin/clang++"
    "-DCMAKE_AR=${pkgs.llvmPackages_19.llvm}/bin/llvm-ar"
    "-DCMAKE_RANLIB=${pkgs.llvmPackages_19.llvm}/bin/llvm-ranlib"
    "-DLLVM_ENABLE_PROJECTS=clang;lld"
    "-DLLVM_ENABLE_RUNTIMES="
    "-DBUILD_SHARED_LIBS=OFF"
    "-DLLVM_BUILD_LLVM_DYLIB=OFF"
    "-DLLVM_LINK_LLVM_DYLIB=OFF"
    "-DCLANG_LINK_CLANG_DYLIB=OFF"
    "-DLIBCLANG_BUILD_STATIC=ON"
    "-DLLVM_INCLUDE_BENCHMARKS=OFF"
    "-DLLVM_INCLUDE_TESTS=OFF"
    "-DLLVM_INCLUDE_DOCS=OFF"
    "-DCLANG_INCLUDE_TESTS=OFF"
    "-DCLANG_INCLUDE_DOCS=OFF"
    "-DLLVM_TOOL_LLVM_EXEGESIS_BUILD=OFF"
    "-DLLVM_INSTALL_BINUTILS_SYMLINKS=ON"
    "-DLLVM_INSTALL_UTILS=ON"
    "-DCLANG_DEFAULT_RTLIB=compiler-rt"
    "-DCLANG_DEFAULT_CXX_STDLIB=libc++"
    "-DCLANG_DEFAULT_LINKER=lld"
    "-DLLVM_TARGETS_TO_BUILD=${nativeTarget};WebAssembly"
    "-DLLVM_ENABLE_LIBXML2=ON"
    "-DLLVM_ENABLE_ZLIB=ON"
    "-DLLVM_ENABLE_ZSTD=OFF"
    "-DLLVM_ENABLE_TERMINFO=ON"
    "-DLLVM_ENABLE_LIBEDIT=OFF"
    "-DLLVM_BUILD_UTILS=ON"
  ];
in

pkgs.llvmPackages_19.stdenv.mkDerivation {
  pname = "llvm-toolchain-host-unwrapped";
  inherit (llvm) version;
  inherit src;

  nativeBuildInputs = [
    pkgs.cmake
    pkgs.ninja
    pkgs.perl
    pkgs.python3
  ];

  buildInputs = [
    pkgs.libffi
    pkgs.libxml2
    pkgs.ncurses
    pkgs.zlib
  ];

  postPatch = ''
    (cd clang && patch -p1 <${llvm.patches.clangWasmLinuxTarget})
    patch -p1 <${llvm.patches.llvmRemoveMmapFork}
    patch -p1 <${llvm.patches.compilerRtWasm}
  '';

  configurePhase = ''
    runHook preConfigure
    cmake -S llvm -B build -G Ninja -DCMAKE_INSTALL_PREFIX=$out ${pkgs.lib.escapeShellArgs cmakeFlags}
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    cmake --build build --target install -j$NIX_BUILD_CORES
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    ln -sf clang $out/bin/cc
    ln -sf clang++ $out/bin/c++
    ln -sf ld.lld $out/bin/ld
    runHook postInstall
  '';
}
