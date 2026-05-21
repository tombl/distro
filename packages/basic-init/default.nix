{ pkgs }:

let
  config = import ../../config.nix;
  inherit (pkgs.wasmpkgs) llvm-toolchain-host platform sysroot;
  inherit (pkgs) lib;
  clang = llvm-toolchain-host;
  lld = llvm-toolchain-host;
  compileFlags = [
    "--target=${platform.targetTriple}"
    "--sysroot=${sysroot}"
  ]
  ++ platform.userlandCFlags;
  linkFlags = compileFlags ++ [
    "-Wl,${lib.concatStringsSep "," platform.linkerFlags}"
  ];
in

pkgs.stdenvNoCC.mkDerivation {
  name = "basic-init";
  src = ./.;
  nativeBuildInputs = [
    clang
    lld
  ];
  buildPhase = ''
    runHook preBuild

    clang -c -o init.o init.c ${lib.escapeShellArgs compileFlags} ${lib.optionalString config.debug "-g"}
    clang -o init init.o ${lib.escapeShellArgs linkFlags}

    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    cp init $out/bin

    runHook postInstall
  '';
}
