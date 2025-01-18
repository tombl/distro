{
  fetch,
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
    src = fetch.github {
      owner = "tombl";
      repo = "linux";
      rev = "refs/heads/wasm";
      hash = "sha256-SBj9onoL7QlesAKM+6UVZ12UbpoyQjG59Uf59+dgv90=";
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

    make defconfig ${if enableDebug then "debug.config" else ""}

    # this is a horrible dirty hack but there's some non-deterministic build failure
    for i in $(seq 1 3); do
      if make -C tools/wasm; then
        break
      fi
    done

    cp -r tools/wasm/dist $out

    make headers_install INSTALL_HDR_PATH=$headers
  ''
