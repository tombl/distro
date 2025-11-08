{
  run,
  libcxx,
  musl,
  linux,
}:

run { name = "sysroot"; } ''
  mkdir -p $out/lib $out/include $out/share

  cp ${libcxx}/lib/* $out/lib/
  cp -r ${libcxx}/include/c++ $out/include/
  cp -r ${libcxx}/share/libc++ $out/share/
  cp -r ${musl}/include/* $out/include/
  cp ${musl}/lib/* $out/lib/
  cp -r ${linux.headers}/* $out/include/
''
