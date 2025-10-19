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
  clang-no-wasm-libs = clang;
  clang = pkgs.runCommand "clang-with-wasm-libs" { } ''
    mkdir -p $out/lib/clang/19/lib/wasm32-linux
    mkdir -p $out/lib/clang/19/include/c++
    mkdir -p $out/lib/clang/19/share
    cp -r ${clang}/* $out/
    cp ${wasmpkgs.compiler-rt}/libclang_rt.builtins-wasm32.a $out/lib/clang/19/lib/wasm32-linux/libclang_rt.builtins.a
    cp ${wasmpkgs.libcxx}/lib/libc++.a $out/lib/clang/19/lib/wasm32-linux/
    cp ${wasmpkgs.libcxx}/lib/libc++experimental.a $out/lib/clang/19/lib/wasm32-linux/
    cp ${wasmpkgs.libcxx}/lib/libc++abi.a $out/lib/clang/19/lib/wasm32-linux/
    cp ${wasmpkgs.libcxx}/lib/libunwind.a $out/lib/clang/19/lib/wasm32-linux/
    cp -r ${wasmpkgs.libcxx}/include/c++/v1 $out/lib/clang/19/include/c++/
    cp -r ${wasmpkgs.libcxx}/share/libc++ $out/lib/clang/19/share/
    cp -r ${wasmpkgs.musl}/include/* $out/lib/clang/19/include/
    cp ${wasmpkgs.musl}/lib/libc.a $out/lib/clang/19/lib/wasm32-linux/
    cp -r ${wasmpkgs.linux.headers}/* $out/lib/clang/19/include/
  '';
  clang-host = llvm.clang;
  clang-tblgen = llvm.clang-unwrapped.dev;
  inherit (llvm) lld llvm-tblgen;
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
