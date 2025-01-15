# basic build dependencies from nixpkgs for cross compilation

{ pkgs }:

let
  llvm = pkgs.llvmPackages_19;
in

{
  clang = llvm.clang-unwrapped;
  clang-host = llvm.clang;
  inherit (llvm) lld;
  inherit (pkgs)
    bash
    bc
    bison
    busybox
    cmake
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
