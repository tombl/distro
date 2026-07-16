# The kernel is a build-platform artifact: a wasm blob plus the JavaScript
# that hosts it, loaded by the runner and the site. Built with explicit tools
# rather than the wasm stdenv because kbuild drives its own cross setup.
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
    "site"
    "headers"
  ];

  # The outputs are wasm, JavaScript, and headers: nixpkgs' fixup would strip
  # nothing and would patch shebangs in files served to browsers.
  dontFixup = true;

  nativeBuildInputs = [
    llvm-toolchain-unwrapped
    pkgs.bc
    pkgs.bison
    pkgs.esbuild
    pkgs.findutils
    pkgs.flex
    pkgs.gnumake
    pkgs.perl
    pkgs.rsync
    pkgs.wabt
  ];

  buildPhase = ''
    runHook preBuild

    mkdir -p $site
    cp -r tools/wasm/{run.js,public/*,src} $site
    ln -sf $out $site/dist

    make() {
      command make -j$NIX_BUILD_CORES HOSTCC=${pkgs.llvmPackages_19.clang}/bin/clang TSC=true "$@"
    }

    config() {
      sed -i "/CONFIG_$1=/d" .config
      sed -i "/CONFIG_$1 is not set/d" .config
      case $2 in
        y|n) echo "CONFIG_$1=$2" >> .config ;;
        *) echo "CONFIG_$1=\"$2\"" >> .config ;;
      esac
    }

    [ -f .config ] || make defconfig ${lib.optionalString debug "debug.config"}
    config BLOCK y
    config BLK_DEV y
    config BLK_DEV_INITRD y
    config DEVTMPFS y
    config EXT4_FS y
    config FILE_LOCKING y
    config OVERLAY_FS n
    config SQUASHFS n
    config VIRTIO_BLK y
    config VIRTIO_WASM y
    make olddefconfig

    # this is a horrible dirty hack but there's some non-deterministic build failure
    for i in $(seq 1 3); do
      if make -C tools/wasm; then
        break
      fi
    done

    cp -r tools/wasm/dist $out
    hash=$(cksum $out/index.js | cut -d' ' -f1)
    sed -i "s/LIBRARY_VERSION/$hash/" $site/index.html

    make headers_install INSTALL_HDR_PATH=$headers

    runHook postBuild
  '';

  installPhase = "runHook preInstall; runHook postInstall";
}
