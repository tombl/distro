{
  pkgs,
  stdenv,
  src,
}:

stdenv.mkDerivation {
  pname = "sqlite3";
  version = "3.51.0";
  inherit src;

  # sqlite's configure builds a code generator with the build compiler.
  depsBuildBuild = [ pkgs.stdenv.cc ];

  configureFlags = [ "--disable-shared" ];

  env.NIX_CFLAGS_COMPILE = "-DSQLITE_OMIT_WAL=1 -DSQLITE_MAX_MMAP_SIZE=0";
}
