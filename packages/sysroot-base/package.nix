# musl and kernel headers only: enough to build the compiler runtimes without
# depending on them.
{
  pkgs,
  linux,
  musl,
}:

pkgs.runCommand "sysroot-base" { } ''
  mkdir -p $out/lib $out/include

  cp -r ${musl}/include/* $out/include/
  chmod -R u+w $out/include
  cp ${musl}/lib/* $out/lib/
  cp -r ${linux.headers}/include/* $out/include/
''
