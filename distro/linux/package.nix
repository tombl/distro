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
    rev = "015960b05977b3ef9a4370b6a0ea0fb47c063d90";
    hash = "sha256-8TGFmhORlsz6Izz8VRrN4FpLpxHefZaxO9G35+zLJro=";
  },
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "linux";
  inherit src;
  inherit ((builtins.fromJSON (builtins.readFile "${src}/tools/wasm/package.json"))) version;

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

    # this is a horrible dirty hack but there's some non-deterministic build failure
    for i in $(seq 1 3); do
      if make -C tools/wasm vmlinux.wasm; then
        break
      fi
    done

    cp tools/wasm/vmlinux.wasm $out/

    make headers_install INSTALL_HDR_PATH=$headers

    runHook postBuild
  '';

  installPhase = "runHook preInstall; runHook postInstall";
}
