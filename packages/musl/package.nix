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

  # The wasm binfmt loader passes argv and envp but no auxv; __init_libc walks
  # the bytes after envp as though they were one, which intermittently traps at
  # startup. Point libc.auxv at an empty terminated auxv on wasm until the
  # kernel provides a real one; drop this when binfmt_wasm emits a real auxv.
  patches = [ ./wasm-auxv.patch ];

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
