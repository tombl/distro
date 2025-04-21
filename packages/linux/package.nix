{
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
    src = fetchGit {
      url = "https://github.com/tombl/linux.git";
      rev = "bb08b9388b4ec987fa806958ecf30d1e7dc440d9";
      ref = "wasm";
      hash = "sha256-FFYZOum0bwUPmoUKW7u2oozUzb2gDwE5Cfwp4GundAg=";
      shallow = true;
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

    test -f .config || make defconfig ${lib.optionalString config.debug "debug.config"}

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
