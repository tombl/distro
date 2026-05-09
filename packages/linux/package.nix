{
  fetch,
  run,
  config,
  lib,

  bc,
  bison,
  clang-no-compiler-rt,
  clang-host ? clang-no-compiler-rt,
  esbuild,
  findutils,
  flex,
  gnumake,
  lld,
  llvm,
  perl,
  rsync,
  wabt,
}:

run
  {
    name = "linux";
    src = fetch.github {
      owner = "tombl";
      repo = "linux";
      rev = "f9c0796e7116aeb7451c4ebeaa968ff84af4c54c";
      hash = "sha256-Rp2mek43UAUcvmXbkpl1OCFiToB9pQ6bBqkWBnQwEyE=";
    };
    path = [
      bc
      bison
      clang-no-compiler-rt
      esbuild
      findutils
      flex
      gnumake
      lld
      llvm
      perl
      rsync
      wabt
    ];
    outputs = [
      "out"
      "site"
      "headers"
    ];
  }
  ''
    mkdir -p $site
    cp -r tools/wasm/{run.js,public/*,src} $site
    ln -sf $out $site/dist

    make() {
      command make -j$NIX_BUILD_CORES HOSTCC=${clang-host}/bin/clang TSC=true "$@"
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
  ''
