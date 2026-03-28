# basic build dependencies from nixpkgs for cross compilation

{ pkgs, wasmpkgs }:

let
  llvm = pkgs.llvmPackages_19;
  clang = llvm.clang-unwrapped.overrideAttrs (attrs: {
    patches = attrs.patches or [ ] ++ [ ./packages/clang/clang-add-wasm-linux-target.patch ];
  });
in

{
  clang-no-compiler-rt = clang;
  clang = pkgs.runCommandNoCCLocal "clang" { } ''
    cp -r ${clang} $out
    chmod -R +w $out
    ln -s $out/bin/clang $out/bin/cc
    ln -s $out/bin/clang++ $out/bin/c++

    cp -r ${clang.lib}/lib/clang $out/lib/
    chmod -R +w $out/lib/clang

    mkdir -p $out/lib/clang/19/lib/wasm32 $out/lib/clang/19/lib/wasm32-unknown $out/lib/clang/19/lib/wasm32-unknown-linux-musl
    cp ${wasmpkgs.compiler-rt}/libclang_rt.builtins-wasm32.a $out/lib/clang/19/lib/wasm32/libclang_rt.builtins.a
    cp ${wasmpkgs.compiler-rt}/libclang_rt.builtins-wasm32.a $out/lib/clang/19/lib/wasm32-unknown/libclang_rt.builtins.a
    cp ${wasmpkgs.compiler-rt}/libclang_rt.builtins-wasm32.a $out/lib/clang/19/lib/wasm32-unknown-linux-musl/libclang_rt.builtins.a
  '';
  clang-host = llvm.clang;
  clang-tblgen = llvm.clang-unwrapped.dev;
  inherit (llvm) lld;
  inherit (pkgs)
    bash
    busybox
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
    rsync
    wabt
    ;
  llvm = llvm.libllvm;
  python3 = pkgs.python314;
}
