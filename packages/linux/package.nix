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
      rev = "b32c91b69e2e4a0dad815a396b1340dc895d3e7c";
      hash = "sha256-wI4r6MMagy/CZ6vbZGckoDVdSXtwdjWraJ3VNga5Kfk=";
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

    if ! [ -f .config ]; then
      make defconfig ${lib.optionalString config.debug "debug.config"}
      config FILE_LOCKING y
    fi

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
