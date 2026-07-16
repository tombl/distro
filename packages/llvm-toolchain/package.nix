# The build-platform toolchain with the wasm runtimes in clang's resource
# directory. This is what gets cc-wrapped into the scope's stdenv, and what the
# devshell exposes for compiling wasm by hand. Its target is always wasm, so
# `ld` is wasm-ld.
{
  pkgs,
  platform,
  llvm-runtimes,
  llvm-toolchain-unwrapped,
}:

pkgs.runCommand "llvm-toolchain-19.1.7"
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
    mkdir -p $out/lib/clang/19/lib

    cp -r ${llvm-runtimes}/lib/clang/19/lib/${platform.targetTriple} $out/lib/clang/19/lib/
    cp -r ${llvm-runtimes}/lib/clang/19/lib/wasm32 $out/lib/clang/19/lib/
    cp -r ${llvm-runtimes}/lib/clang/19/lib/wasm32-unknown $out/lib/clang/19/lib/

    ln -sf wasm-ld $out/bin/ld
  ''
