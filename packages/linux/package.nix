{
  inputs,
  run,

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

  enableDebug ? false,
}:

run
  {
    name = "linux";
    src = inputs.linux;
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
    alias make="echo make -j$NIX_BUILD_CORES HOSTCC=${clang-host}/bin/clang TSC=true"

    make defconfig
    ${if enableDebug then "make debug.config" else ""}

    # this is a horrible dirty hack but there's some non-deterministic build failure
    for i in $(seq 1 3); do
      if make -C tools/wasm; then
        break
      fi
    done

    mkdir $out
    rm tools/wasm/public/dist
    cp tools/wasm/public/* $out/
    cp -r tools/wasm/dist $out/dist

    make headers_install INSTALL_HDR_PATH=$headers
  ''
