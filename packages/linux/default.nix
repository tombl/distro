{
  pkgs,
  src,
}:

let
  config = import ../../config.nix;
  inherit (pkgs)
    bc
    bison
    esbuild
    findutils
    flex
    gnumake
    nodejs
    perl
    rsync
    typescript
    wabt
    lib
    ;
  inherit (pkgs.llvmPackages_19)
    clang
    clang-unwrapped
    lld
    libllvm
    ;
in

pkgs.llvmPackages_19.stdenv.mkDerivation {
  name = "linux";
  inherit src;
  nativeBuildInputs = [
    bc
    bison
    clang-unwrapped
    esbuild
    findutils
    flex
    gnumake
    lld
    libllvm
    nodejs
    perl
    rsync
    typescript
    wabt
  ];
  outputs = [
    "out"
    "headers"
  ];
  outputInclude = "headers";
  configurePhase = ''
    runHook preConfigure

    export HOME=$TMPDIR

    make() {
      command make -j$NIX_BUILD_CORES HOSTCC=${clang}/bin/clang "$@"
    }

    config() {
      sed -i "/CONFIG_$1=/d" .config
      sed -i "/CONFIG_$1 is not set/d" .config
      case $2 in
        y|n) echo "CONFIG_$1=$2" >> .config ;;
        *) echo "CONFIG_$1=\"$2\"" >> .config ;;
      esac
    }

    [ -f .config ] || make defconfig ${lib.optionalString config.debug "debug.config"}
    config BLOCK y
    config BLK_DEV y
    config BLK_DEV_INITRD y
    config DEVTMPFS y
    config EXT4_FS y
    config FILE_LOCKING y
    config NET y
    config OVERLAY_FS n
    config SQUASHFS n
    config VIRTIO_BLK y
    config VSOCKETS y
    config VIRTIO_VSOCKETS y
    config VIRTIO_WASM y
    make olddefconfig

    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild

    export HOME=$TMPDIR
    export npm_config_cache=$TMPDIR/npm-cache

    make() {
      command make -j$NIX_BUILD_CORES HOSTCC=${clang}/bin/clang "$@"
    }

    make -C tools/wasm pack NPM=${nodejs}/bin/npm

    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall

    make() {
      command make -j$NIX_BUILD_CORES HOSTCC=${clang}/bin/clang "$@"
    }

    mkdir -p $out
    cp tools/wasm/linux.tgz $out/

    make headers_install INSTALL_HDR_PATH=$headers

    runHook postInstall
  '';
}
