# The complete target sysroot: musl, kernel headers, compiler-rt, and libc++.
{
  pkgs,
  platform,
  llvm-runtimes,
  sysroot-base,
}:

pkgs.runCommand "sysroot" { } ''
  mkdir -p $out/lib $out/include/${platform.multiarchTriple} $out/share

  cp -r ${sysroot-base}/include/* $out/include/
  cp ${sysroot-base}/lib/* $out/lib/

  cp -r ${llvm-runtimes}/include/c++ $out/include/
  cp -r ${llvm-runtimes}/include/${platform.targetTriple}/c++ $out/include/${platform.multiarchTriple}/
  cp -r ${llvm-runtimes}/share/libc++ $out/share/
  cp ${llvm-runtimes}/lib/${platform.targetTriple}/* $out/lib/
''
