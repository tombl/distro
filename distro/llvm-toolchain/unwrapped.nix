# clang/lld for the build platform, from the tombl/llvm-project fork whose
# wasm-linux branch carries the wasm32-unknown-linux-musl target.
{
  pkgs,
  src ? pkgs.fetchFromGitHub {
    owner = "tombl";
    repo = "llvm-project";
    rev = "9aaceb42fef4f924a00126e0d66140d01482921c";
    hash = "sha256-UXfcTGqVJsIVQHDSSF2tcRuM7zysJycaEsmCmlepVVM=";
  },
}:

let
  llvmPackages = pkgs.llvmPackages_22;

  nativeTarget =
    if pkgs.stdenv.hostPlatform.isx86_64 then
      "X86"
    else if pkgs.stdenv.hostPlatform.isAarch64 then
      "AArch64"
    else
      throw "unsupported LLVM host target: ${pkgs.stdenv.hostPlatform.config}";

  cmakeFlags = [
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_C_COMPILER=${llvmPackages.clang}/bin/clang"
    "-DCMAKE_CXX_COMPILER=${llvmPackages.clang}/bin/clang++"
    "-DCMAKE_AR=${llvmPackages.llvm}/bin/llvm-ar"
    "-DCMAKE_RANLIB=${llvmPackages.llvm}/bin/llvm-ranlib"
    "-DLLVM_ENABLE_PROJECTS=clang;lld"
    "-DLLVM_ENABLE_RUNTIMES="
    "-DBUILD_SHARED_LIBS=OFF"
    "-DLLVM_BUILD_LLVM_DYLIB=OFF"
    "-DLLVM_LINK_LLVM_DYLIB=OFF"
    "-DCLANG_LINK_CLANG_DYLIB=OFF"
    "-DLIBCLANG_BUILD_STATIC=ON"
    "-DLLVM_INCLUDE_BENCHMARKS=OFF"
    "-DLLVM_INCLUDE_EXAMPLES=OFF"
    "-DLLVM_INCLUDE_TESTS=OFF"
    "-DLLVM_INCLUDE_DOCS=OFF"
    "-DCLANG_INCLUDE_TESTS=OFF"
    "-DCLANG_INCLUDE_DOCS=OFF"
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
    # One multicall `llvm` binary serves clang, lld and the binutils
    # replacements through symlinks, instead of each statically linking its
    # own copy of LLVM (149 tools, 1.7 GB of the 2.5 GB output).
    "-DLLVM_TOOL_LLVM_DRIVER_BUILD=ON"
  ]
  # Tools nothing here uses: JITs, reducers, debuggers' helpers, offloading
  # and refactoring front ends.
  ++ map (tool: "-DLLVM_TOOL_${tool}_BUILD=OFF") [
    "BUGPOINT"
    "BUGPOINT_PASSES"
    "DXIL_DIS"
    "LLI"
    "LTO"
    "LLVM_C_TEST"
    "LLVM_CFI_VERIFY"
    "LLVM_DEBUGINFO_ANALYZER"
    "LLVM_DWARFUTIL"
    "LLVM_EXEGESIS"
    "LLVM_GPU_LOADER"
    "LLVM_IR2VEC"
    "LLVM_JITLINK"
    "LLVM_LTO"
    "LLVM_LTO2"
    "LLVM_MCA"
    "LLVM_OFFLOAD_BINARY"
    "LLVM_OFFLOAD_WRAPPER"
    "LLVM_PDBUTIL"
    "LLVM_PROFGEN"
    "LLVM_REDUCE"
    "LLVM_RTDYLD"
    "LLVM_SIM"
    "LLVM_SPLIT"
    "LLVM_STRESS"
    "LLVM_XRAY"
    "SPIRV_TOOLS"
  ]
  ++ map (tool: "-DCLANG_TOOL_${tool}_BUILD=OFF") [
    "CLANG_CHECK"
    "CLANG_DIFF"
    "CLANG_EXTDEF_MAPPING"
    "CLANG_FORMAT"
    "CLANG_IMPORT_TEST"
    "CLANG_LINKER_WRAPPER"
    "CLANG_NVLINK_WRAPPER"
    "CLANG_REFACTOR"
    "CLANG_REPL"
    "CLANG_SHLIB"
    "CLANG_SYCL_LINKER"
    "DIAGTOOL"
    "OFFLOAD_ARCH"
  ];
in

llvmPackages.stdenv.mkDerivation {
  pname = "llvm-toolchain-unwrapped";
  version = llvmPackages.release_version;
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
