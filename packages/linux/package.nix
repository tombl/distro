# The kernel is a build-platform artifact: a wasm blob plus its JavaScript
# host library. It uses explicit tools because kbuild drives its own cross
# setup rather than the wasm stdenv.
{
  pkgs,
  lib,
  debug,
  llvm-toolchain-unwrapped,
  src,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "linux";
  inherit src;
  inherit ((builtins.fromJSON (builtins.readFile "${src}/tools/wasm/package.json"))) version;

  outputs = [
    "out"
    "headers"
  ];

  # The outputs are wasm, JavaScript, and headers: nixpkgs' fixup would strip
  # nothing and would patch shebangs in files served to browsers.
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
    pkgs.typescript
    pkgs.wabt
  ];

  # npm trusted publishing verifies that package metadata names the repository
  # containing the release workflow, while the upstream source keeps pointing
  # at the kernel repository.
  postPatch = ''
    substituteInPlace tools/wasm/package.json \
      --replace-fail 'git+https://github.com/tombl/linux.git' 'git+https://github.com/tombl/distro.git' \
      --replace-fail '"directory": "tools/wasm"' '"directory": "packages/linux"'
  '';

  buildPhase = ''
    runHook preBuild

    make() {
      command make -j$NIX_BUILD_CORES HOSTCC=${pkgs.llvmPackages_22.clang}/bin/clang "$@"
    }

    make mrproper
    make -C tools/wasm clean
    mkdir -p $out

    make defconfig ${lib.optionalString debug "debug.config"}

    # this is a horrible dirty hack but there's some non-deterministic build failure
    for i in $(seq 1 3); do
      if make -C tools/wasm; then
        break
      fi
    done

    make -C tools/wasm pack
    cp -r tools/wasm/dist $out/
    cp tools/wasm/linux.tgz $out/
    cp tools/wasm/vmlinux.wasm $out/

    make headers_install INSTALL_HDR_PATH=$headers

    runHook postBuild
  '';

  installPhase = "runHook preInstall; runHook postInstall";
}
