{ pkgs }:

let
  inherit (pkgs.wasmpkgs) llvm-runtimes-wasm sysroot-base;
  inherit (pkgs) lib;
  llvm = import ../llvm-toolchain/common.nix { inherit lib; };
in

pkgs.runCommand "sysroot" { } ''
  mkdir -p $out/lib $out/include/${llvm.multiarchTriple} $out/share

  cp -r ${sysroot-base}/include/* $out/include/
  cp ${sysroot-base}/lib/* $out/lib/

  cp -r ${llvm-runtimes-wasm}/include/c++ $out/include/
  cp -r ${llvm-runtimes-wasm}/include/${llvm.targetTriple}/c++ $out/include/${llvm.multiarchTriple}/
  cp -r ${llvm-runtimes-wasm}/share/libc++ $out/share/
  cp ${llvm-runtimes-wasm}/lib/${llvm.targetTriple}/* $out/lib/
''
