# basic build dependencies from nixpkgs for cross compilation

{ pkgs, wasmpkgs }:

let
  llvm = pkgs.llvmPackages_19;
  clang = llvm.clang-unwrapped.overrideAttrs (attrs: {
    patches = attrs.patches or [ ] ++ [ ./packages/clang/add-wasm-linux-target.patch ];
  });
in

{
  busybox-host = pkgs.busybox;
  clang-no-compiler-rt = clang;
  clang = pkgs.runCommand "clang-with-wasm-compiler-rt" { } ''
    mkdir -p $out/lib/clang/19/lib/wasm32-unknown
    cp -r ${clang}/* $out/
    cp ${wasmpkgs.compiler-rt}/libclang_rt.builtins-wasm32.a $out/lib/clang/19/lib/wasm32-unknown/libclang_rt.builtins.a
  '';
  clang-host = llvm.clang;
  inherit (llvm) lld;
  inherit (pkgs)
    bash
    bc
    bison
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
