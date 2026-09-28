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

pkgs.stdenvNoCC.mkDerivation {
  pname = "linux";
  version = "0.0.0";
  inherit src;

  outputs = [
    "out"
    "headers"
  ];

  # The outputs are wasm and headers: nixpkgs' fixup would strip nothing.
  dontFixup = true;

  nativeBuildInputs = [
    llvm-toolchain-unwrapped
    pkgs.bc
    pkgs.bison
    pkgs.findutils
    pkgs.flex
    pkgs.gnumake
    pkgs.perl
    pkgs.rsync
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

    make headers_install INSTALL_HDR_PATH=$headers

    runHook postBuild
  '';

  installPhase = "runHook preInstall; runHook postInstall";
}
