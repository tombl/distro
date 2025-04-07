{
  fetch,
  run,
  config,
  lib,

  bc,
  bison,
  clang-host ? clang,
  clang,
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
      rev = "refs/heads/wasm";
      hash = "sha256-rK+2aXZ4K/9ObHI0oKTysVt54U/vXf5JslikUB8Iv7M=";
    };
    path = [
      bc
      bison
      clang
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
      "headers"
    ];
  }
  ''
    make() {
      command make -j$NIX_BUILD_CORES HOSTCC=${clang-host}/bin/clang TSC=true "$@"
    }

    test -f .config || make defconfig ${lib.optionalString config.debug "debug.config"}

    # this is a horrible dirty hack but there's some non-deterministic build failure
    for i in $(seq 1 3); do
      if make -C tools/wasm; then
        break
      fi
    done

    cp -r tools/wasm/dist $out

    make headers_install INSTALL_HDR_PATH=$headers
  ''
