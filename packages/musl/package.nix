{
  pkgs,
  lib,
  debug,
  llvm-toolchain-unwrapped,
  src ? pkgs.fetchFromGitHub {
    owner = "tombl";
    repo = "musl";
    rev = "637b0d25dafa7e4740357f25fb0b5e3949f1ed1f";
    hash = "sha256-JsiHpPB8EVs7uyI1fbnoGy3f17KrEf4nCi5nHE31du8=";
  },
  mimallocSrc ? pkgs.fetchFromGitHub {
    owner = "microsoft";
    repo = "mimalloc";
    rev = "v3.4.4";
    hash = "sha256-CJ2sOio5cttIG27ZiotaES9X+ymHR5HXWK/O0JUjlC4=";
  },
}:

pkgs.stdenvNoCC.mkDerivation {
  name = "musl";
  inherit src;

  nativeBuildInputs = [ llvm-toolchain-unwrapped ];

  patches = [ ./musl-mimalloc.patch ];

  postPatch = ''
    cp -R ${mimallocSrc} mimalloc
    chmod -R u+w mimalloc
    patch -d mimalloc -p1 < ${./mimalloc-wasm-linux.patch}
  '';

  # TODO: split for size, only relevant for dynamic linking
  # outputs = [ "out" "dev" ];
  configurePhase = ''
    runHook preConfigure

    cat >config.mak <<EOF
    ARCH=wasm32
    SHARED_LIBS=
    MALLOC_DIR=mimalloc
    MIMALLOC_SRC=mimalloc
    MIMALLOC_CFLAGS=${lib.optionalString debug "-DMI_DEBUG=2"}
    prefix=$out
    syslibdir=$out
    CFLAGS=${lib.optionalString debug "-g"}
    EOF

    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    make clean
    make -j$NIX_BUILD_CORES
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir $out
    make -j$NIX_BUILD_CORES install-libs install-headers
    runHook postInstall
  '';
}
