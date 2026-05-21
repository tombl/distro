{ lib }:

rec {
  version = "19.1.7";
  majorVersion = lib.head (lib.splitVersion version);
  targetTriple = "wasm32-unknown-linux-musl";
  multiarchTriple = "wasm32-linux-musl";

  patches = {
    clangWasmLinuxTarget = ./clang-add-wasm-linux-target.patch;
    llvmRemoveMmapFork = ./llvm-remove-mmap-fork.patch;
    compilerRtWasm = ./compiler-rt-wasm.patch;
    lldWasmOnly = ./lld-wasm-only.patch;
  };
}
