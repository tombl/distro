{
  fetch,
  run,
  lib,
  config,

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
      hash = "sha256-cL/QLG0etQ1TxTBRMrKR5VESGPC73CDcoVomInmL8yE=";
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
        CFLAGS_busybox="${musl}/lib/crt1.o -Wl,--import-memory -Wl,--max-memory=4294967296 -Wl,--shared-memory -Wl,--export-table" "$@"
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
    config EXTRA_CFLAGS '-nostdlib -isystem ${musl}/include -I${linux.headers}/include ${lib.optionalString config.debug "-g"} -matomics -mbulk-memory'
    config EXTRA_LDFLAGS ${compiler-rt}/libclang_rt.builtins-wasm32.a
    config EXTRA_LDLIBS c

    config BOOTCHARTD n
    config CONSPY n
    config CROND n
    config CRONTAB n
    config DEVMEM n
    config FBSPLASH n
    config FTPD n
    config HDPARM n
    config HEXEDIT n
    config HTTPD n
    config IFDOWN n
    config IFUP n
    config INETD n
    config NC n
    config NSENTER n
    config SCRIPT n
    config START_STOP_DAEMON n
    config SWAPOFF n
    config SWAPON n
    config TCPSVD n
    config TELNETD n
    config TIME n
    config TS n
    config UDPSVD n
    config WGET n

    config SENDMAIL n
    config REFORMIME n
    config MAKEMIME n
    config POPMAILDIR n

    config INIT n
    config LINUXRC n

    config RUNSV n
    config RUNSVDIR n
    config SVLOGD n

    config HUSH_TICK n

    config HWCLOCK n
    config RTCWAKE n

    cat .config
    make oldconfig

    make ${lib.optionalString config.debug "SKIP_STRIP=y"}

    mkdir -p $out/bin
    cp busybox $out/bin
  ''
