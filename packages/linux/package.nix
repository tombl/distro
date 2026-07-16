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
  name = "linux";
  inherit src;

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

  buildPhase = ''
    runHook preBuild

    make() {
      command make -j$NIX_BUILD_CORES HOSTCC=${pkgs.llvmPackages_19.clang}/bin/clang "$@"
    }

    make mrproper
    make -C tools/wasm clean
    mkdir -p $out

    config() {
      sed -i "/CONFIG_$1=/d" .config
      sed -i "/CONFIG_$1 is not set/d" .config
      case $2 in
        y|n) echo "CONFIG_$1=$2" >> .config ;;
        *) echo "CONFIG_$1=\"$2\"" >> .config ;;
      esac
    }

    make defconfig ${lib.optionalString debug "debug.config"}
    config BLOCK y
    config BLK_DEV y
    config BLK_DEV_INITRD y
    config DEVTMPFS y
    config EXT4_FS y
    config FILE_LOCKING y
    config FUTEX y
    config NET y
    config OVERLAY_FS n
    config SQUASHFS y
    config VIRTIO_BLK y
    config VIRTIO_VSOCKETS y
    config VIRTIO_WASM y
    config VSOCKETS y
    make olddefconfig

    # this is a horrible dirty hack but there's some non-deterministic build failure
    for i in $(seq 1 3); do
      if make -C tools/wasm; then
        break
      fi
    done

    make -C tools/wasm pack PACKAGE_VERSION=0.0.0
    cp -r tools/wasm/dist $out/
    cp tools/wasm/linux.tgz $out/
    cp tools/wasm/vmlinux.wasm $out/

    make headers_install INSTALL_HDR_PATH=$headers

    runHook postBuild
  '';

  installPhase = "runHook preInstall; runHook postInstall";
}
