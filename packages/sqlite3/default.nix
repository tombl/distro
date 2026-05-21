{
  pkgs,
  src,
}:

let
  config = import ../../config.nix;
  inherit (pkgs.wasmpkgs)
    llvm-toolchain-host
    platform
    sysroot
    ;
  inherit (pkgs) gnumake lib;
  clang = llvm-toolchain-host;
  clang-host = pkgs.llvmPackages_19.clang;
  lld = llvm-toolchain-host;
  llvm = llvm-toolchain-host;
  targetFlags = lib.concatStringsSep " " (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.userlandCFlags
  );

in

pkgs.stdenvNoCC.mkDerivation {
  name = "sqlite3";
  version = "3.51.0";

  inherit src;

  nativeBuildInputs = [
    gnumake
    lld
    llvm
  ];
  configurePhase = ''
    runHook preConfigure

    export CC_FOR_BUILD=${clang-host}/bin/clang
    export CC=${clang}/bin/clang
    export CFLAGS="${targetFlags} ${lib.optionalString config.debug "-g"} -DSQLITE_OMIT_WAL=1 -DSQLITE_MAX_MMAP_SIZE=0"
    export LD=wasm-ld
    export LDFLAGS="--target=${platform.targetTriple} --sysroot=${sysroot} -fuse-ld=lld"
    export AR=llvm-ar

    ./configure --host=${platform.targetTriple} --prefix=$out

    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild

    make -j$NIX_BUILD_CORES

    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall

    make -j$NIX_BUILD_CORES install

    runHook postInstall
  '';
}
