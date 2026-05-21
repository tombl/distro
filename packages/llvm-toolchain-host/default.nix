{ pkgs }:

let
  inherit (pkgs.wasmpkgs) llvm-runtimes-wasm llvm-toolchain-host-unwrapped sysroot;
  llvm = import ../llvm-toolchain/common.nix { inherit (pkgs) lib; };
in

pkgs.runCommand "llvm-toolchain-host-${llvm.version}" { } ''
  cp -r ${llvm-toolchain-host-unwrapped} $out
  chmod -R u+w $out
  mkdir -p $out/lib/${llvm.targetTriple} $out/lib/clang/${llvm.majorVersion}/lib

  cp -r ${llvm-runtimes-wasm}/include/* $out/include/
  cp -r ${llvm-runtimes-wasm}/share/* $out/share/
  cp ${llvm-runtimes-wasm}/lib/${llvm.targetTriple}/* $out/lib/${llvm.targetTriple}/
  cp -r ${llvm-runtimes-wasm}/lib/clang/${llvm.majorVersion}/lib/${llvm.targetTriple} $out/lib/clang/${llvm.majorVersion}/lib/
  cp -r ${llvm-runtimes-wasm}/lib/clang/${llvm.majorVersion}/lib/wasm32 $out/lib/clang/${llvm.majorVersion}/lib/
  cp -r ${llvm-runtimes-wasm}/lib/clang/${llvm.majorVersion}/lib/wasm32-unknown $out/lib/clang/${llvm.majorVersion}/lib/

  cat >$out/bin/${llvm.targetTriple}-clang.cfg <<EOF
  --target=${llvm.targetTriple}
  --sysroot=${sysroot}
  -matomics
  -mbulk-memory
  -fuse-ld=lld
  EOF
  cp $out/bin/${llvm.targetTriple}-clang.cfg $out/bin/${llvm.targetTriple}-clang++.cfg
  ln -sf clang $out/bin/${llvm.targetTriple}-clang
  ln -sf clang++ $out/bin/${llvm.targetTriple}-clang++
  ln -sf clang $out/bin/cc
  ln -sf clang++ $out/bin/c++
  ln -sf ld.lld $out/bin/ld
''
