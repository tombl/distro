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
    rev = "9e5ee060a4bd6f2ccb5db60e7a2ae881305e40a5";
    hash = "sha256-1WQURuw5oNmGea1Ik4OdV2b7v3VCknMDqu9R+FLRKqY=";
  },
}:

let
  installHeaders = {
    pname = "linux-headers";
    version = "0.0.0";
    inherit src;

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

  # The UAPI headers are fixed-output so that kernel bumps which leave them
  # untouched do not change the store path of, and so rebuild, the whole
  # userland. Nix never rebuilds a fixed-output path it already has, though,
  # so a bump that changes them would quietly keep the old headers. The
  # headers check below builds them from the pinned source and fails, naming
  # the new hash to paste here, when they differ.
  headers = pkgs.stdenvNoCC.mkDerivation (
    installHeaders
    // {
      outputHashMode = "recursive";
      outputHashAlgo = "sha256";
      outputHash = "sha256-pBKb2mM3XTh9QYXqZHg0bxrC4XqCRrMxWkXl9eGkbyY=";
    }
  );

  headersFromSource = pkgs.stdenvNoCC.mkDerivation installHeaders;

  headersCheck =
    pkgs.runCommand "linux-headers-check"
      {
        nativeBuildInputs = [ pkgs.nix ];
      }
      ''
        if ! diff -r ${headers} ${headersFromSource} >/dev/null; then
          echo "the pinned kernel's UAPI headers differ from distro/linux's fixed-output headers;" >&2
          echo "set its outputHash to $(nix-hash --type sha256 --sri ${headersFromSource})" >&2
          exit 1
        fi
        mkdir $out
      '';
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "linux";
  version = "0.0.0";
  inherit src;

  passthru = {
    inherit headers;
    checks.headers = headersCheck;
  };

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

    make vmlinux.wasm

    cp vmlinux.wasm $out/

    runHook postBuild
  '';

  installPhase = "runHook preInstall; runHook postInstall";
}
