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
    bc
    bison
    busybox
    esbuild
    findutils
    flex
    gnumake
    perl
    rsync
    wabt
    ;
  llvm = llvm.libllvm;
}
