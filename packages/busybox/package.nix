{
  fetch,
  run,

  clang-host ? clang,
  clang,
  compiler-rt,
  gnumake,
  linux,
  lld,
  llvm,
  musl,
}:

run
  {
    name = "busybox";
    src = fetch.github {
      owner = "tombl";
      repo = "busybox";
      rev = "refs/heads/master";
      hash = "sha256-Sbuibax0P/sz+Pwn5BNASsbzF1iFeo19meO3EFhJZzA=";
    };
    path = [
      clang
      gnumake
      lld
      llvm
    ];
  }
  ''
    make() {
      command make -j$NIX_BUILD_CORES \
        ARCH=wasm32 \
        HOSTCC=${clang-host}/bin/clang \
        CC=${clang}/bin/clang \
        CFLAGS_busybox="${musl}/lib/crt1.o -g -Wl,--import-memory" "$@"
    }

    config() {
      sed -i "/CONFIG_$1=/d" .config
      sed -i "/CONFIG_$1 is not set/d" .config
      case $2 in
        y|n) echo "CONFIG_$1=$2" >> .config ;;
        *) echo "CONFIG_$1=\"$2\"" >> .config ;;
      esac
    }

    make defconfig
    config STATIC y
    config NOMMU y
    config STATIC_LIBGCC n
    config CROSS_COMPILER_PREFIX llvm-
    config SYSROOT ${musl}
    config EXTRA_CFLAGS '-nostdlib -isystem ${musl}/include -I${linux.headers}/include'
    config EXTRA_LDFLAGS ${compiler-rt}/libclang_rt.builtins-wasm32.a
    config EXTRA_LDLIBS c

    cat .config
    make oldconfig

    make

    mkdir -p $out/bin
    cp busybox $out/bin
  ''
