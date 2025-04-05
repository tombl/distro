# basic build dependencies from nixpkgs for cross compilation

{ pkgs, wasmpkgs }:

let
  llvm = pkgs.llvmPackages_19;
in

{
  clang-no-compiler-rt = llvm.clang-unwrapped;
  clang = pkgs.runCommand "clang-with-wasm-compiler-rt" { } ''
    mkdir -p $out/lib/clang/19/lib/wasm32-unknown
    cp -r ${llvm.clang-unwrapped}/* $out/
    cp ${wasmpkgs.compiler-rt}/libclang_rt.builtins-wasm32.a $out/lib/clang/19/lib/wasm32-unknown/libclang_rt.builtins.a
  '';
  clang-host = llvm.clang;
  inherit (llvm) lld;
  inherit (pkgs)
    bash
    bc
    bison
    busybox
    cmake
    curl
    esbuild
    findutils
    flex
    gnumake
    ninja
    perl
    python3
    rsync
    wabt
    ;
  llvm = llvm.libllvm;
}
