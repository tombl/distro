# The build-platform toolchain with the wasm runtimes in clang's resource
# directory. This is what gets cc-wrapped into the scope's stdenv, and what the
# devshell exposes for compiling wasm by hand. Its target is always wasm, so
# `ld` is wasm-ld.
{
  pkgs,
  lib,
  platform,
  llvm-runtimes,
  llvm-toolchain-unwrapped,
}:

let
  inherit (llvm-toolchain-unwrapped) version;
  llvmMajorVersion = lib.versions.major version;
in

pkgs.runCommand "llvm-toolchain-${version}"
  {
    passthru = {
      isClang = true;
      hardeningUnsupportedFlags = [
        "bindnow"
        "fortify"
        "fortify3"
        "pic"
        "pie"
        "relro"
        "shadowstack"
        "stackclashprotection"
        "stackprotector"
        "strictoverflow"
        "trivialautovarinit"
        "zerocallusedregs"
      ];
    };
  }
  ''
    cp -r ${llvm-toolchain-unwrapped} $out
    chmod -R u+w $out
    mkdir -p $out/lib/clang/${llvmMajorVersion}/lib

    cp -r ${llvm-runtimes}/lib/clang/${llvmMajorVersion}/lib/${platform.targetTriple} $out/lib/clang/${llvmMajorVersion}/lib/
    cp -r ${llvm-runtimes}/lib/clang/${llvmMajorVersion}/lib/wasm32 $out/lib/clang/${llvmMajorVersion}/lib/
    cp -r ${llvm-runtimes}/lib/clang/${llvmMajorVersion}/lib/wasm32-unknown $out/lib/clang/${llvmMajorVersion}/lib/

    ln -sf wasm-ld $out/bin/ld
  ''
