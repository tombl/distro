{
  pkgs,
  src,
}:

let
  config = import ../../config.nix;
  inherit (pkgs)
    gnumake
    lib
    ;
  inherit (pkgs.llvmPackages_19)
    clang-unwrapped
    lld
    libllvm
    ;
in

pkgs.llvmPackages_19.stdenv.mkDerivation {
  name = "musl";
  inherit src;
  nativeBuildInputs = [
    clang-unwrapped
    gnumake
    lld
    libllvm
  ];
  # TODO: split for size, only relevant for dynamic linking
  # outputs = [ "out" "dev" ];
  configurePhase = ''
    runHook preConfigure

    cat >config.mak <<EOF
    ARCH=wasm32
    prefix=$out
    syslibdir=$out
    CFLAGS=${lib.optionalString config.debug "-g"}
    EOF

    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild

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
