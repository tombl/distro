# An ordinary nixpkgs-style derivation. The scope's stdenv cross-compiles for
# the guest and stages an FHS install: prefix is `/` and DESTDIR is $out.
{ lib, stdenv }:

stdenv.mkDerivation {
  pname = "hello";
  version = "1.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./Makefile
      ./hello.c
    ];
  };

  meta.description = "Greets the world from Linux on WebAssembly";
}
