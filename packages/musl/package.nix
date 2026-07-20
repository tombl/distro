{
  pkgs,
  lib,
  debug,
  llvm-toolchain-unwrapped,
  src,
}:

pkgs.stdenvNoCC.mkDerivation {
  name = "musl";
  inherit src;

  nativeBuildInputs = [ llvm-toolchain-unwrapped ];

  # TODO: split for size, only relevant for dynamic linking
  # outputs = [ "out" "dev" ];
  configurePhase = ''
    runHook preConfigure

    cat >config.mak <<EOF
    ARCH=wasm32
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
