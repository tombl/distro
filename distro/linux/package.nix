# The kernel is a build-platform artifact: a wasm blob and headers. The
# JavaScript host library lives in the repository's @lowland/kernel workspace
# package. This derivation uses explicit tools because kbuild drives its own
# cross setup rather than the wasm stdenv.
{
  pkgs,
  lib,
  debug,
  llvm-toolchain-unwrapped,
  src ? pkgs.fetchFromGitHub {
    owner = "tombl";
    repo = "linux";
    rev = "f2a512c0d4a34021f3331b77d28992add6d8e7ab";
    hash = "sha256-1tof96XOKraZ5gGQs0PgE5oXLaLH8IM8qLMwFNoQl/Q=";
  },
}:

let
  # The UAPI headers are fixed-output so that kernel bumps which leave them
  # untouched do not change the store path of, and so rebuild, the whole
  # userland. When a bump does change them, the build fails with a hash
  # mismatch that names the new value to paste here.
  headers = pkgs.stdenvNoCC.mkDerivation {
    pname = "linux-headers";
    version = "0.0.0";
    inherit src;

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-pBKb2mM3XTh9QYXqZHg0bxrC4XqCRrMxWkXl9eGkbyY=";

    dontFixup = true;

    nativeBuildInputs = [
      pkgs.gnumake
      pkgs.perl
      pkgs.rsync
    ];

    buildPhase = ''
      runHook preBuild
      make -j$NIX_BUILD_CORES HOSTCC=${pkgs.llvmPackages_22.clang}/bin/clang \
        headers_install INSTALL_HDR_PATH=$out
      runHook postBuild
    '';

    installPhase = "runHook preInstall; runHook postInstall";
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "linux";
  version = "0.0.0";
  inherit src;

  passthru = { inherit headers; };

  # The output is wasm: nixpkgs' fixup would strip nothing.
  dontFixup = true;

  nativeBuildInputs = [
    llvm-toolchain-unwrapped
    pkgs.bc
    pkgs.bison
    pkgs.findutils
    pkgs.flex
    pkgs.gnumake
    pkgs.perl
    pkgs.wabt
  ];

  buildPhase = ''
    runHook preBuild

    make() {
      command make -j$NIX_BUILD_CORES HOSTCC=${pkgs.llvmPackages_22.clang}/bin/clang "$@"
    }

    make mrproper
    mkdir -p $out

    make defconfig ${lib.optionalString debug "debug.config"}

    make vmlinux.wasm ${lib.optionalString pkgs.stdenv.buildPlatform.isDarwin ''"HOSTCFLAGS_gen_init_cpio.o=-include ${./gen-init-cpio-darwin.h}"''}

    cp vmlinux.wasm $out/

    runHook postBuild
  '';

  installPhase = "runHook preInstall; runHook postInstall";
}
