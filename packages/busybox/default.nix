{
  pkgs,
  src,
}:

let
  config = import ../../config.nix;
  inherit (pkgs.wasmpkgs)
    linux
    llvm-toolchain-host
    platform
    sysroot
    ;
  inherit (pkgs)
    gnumake
    lib
    ;
  clang = llvm-toolchain-host;
  clang-host = pkgs.llvmPackages_19.clang;
  lld = llvm-toolchain-host;
  llvm = llvm-toolchain-host;
  targetFlags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.userlandCFlags
  );
  busyboxLdFlags = lib.concatMapStringsSep " " (flag: "-Wl,${flag}") platform.linkerFlags;
in

pkgs.stdenvNoCC.mkDerivation {
  name = "busybox";
  inherit src;
  nativeBuildInputs = [
    clang
    gnumake
    lld
    llvm
  ];
  configurePhase = ''
    runHook preConfigure

    config() {
      sed -i "/CONFIG_$1=/d" .config
      sed -i "/CONFIG_$1 is not set/d" .config
      case $2 in
        y|n) echo "CONFIG_$1=$2" >> .config ;;
        *) echo "CONFIG_$1=\"$2\"" >> .config ;;
      esac
    }

    [ -f .config ] || make -j$NIX_BUILD_CORES \
      ARCH=wasm32 \
      HOSTCC=${clang-host}/bin/clang \
      CC=${clang}/bin/clang \
      CFLAGS_busybox="${busyboxLdFlags}" \
      defconfig
    config STATIC y
    config NOMMU y
    config STATIC_LIBGCC n
    config CROSS_COMPILER_PREFIX llvm-
    config SYSROOT ${sysroot}
    config EXTRA_CFLAGS '-I${linux.headers}/include ${targetFlags} ${lib.optionalString config.debug "-g"}'
    config EXTRA_LDLIBS c

    config MOUNT y
    config SWITCH_ROOT y
    config HUSH y
    config SH_IS_ASH n
    config SH_IS_HUSH y
    config SH_IS_NONE n
    config BASH_IS_ASH n
    config BASH_IS_HUSH n
    config BASH_IS_NONE y

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

    make -j$NIX_BUILD_CORES \
      ARCH=wasm32 \
      HOSTCC=${clang-host}/bin/clang \
      CC=${clang}/bin/clang \
      CFLAGS_busybox="${busyboxLdFlags}" \
      oldconfig

    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild

    make -j$NIX_BUILD_CORES \
      ARCH=wasm32 \
      HOSTCC=${clang-host}/bin/clang \
      CC=${clang}/bin/clang \
      CFLAGS_busybox="${busyboxLdFlags}" \
      ${lib.optionalString config.debug "SKIP_STRIP=y"}

    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall

    make -j$NIX_BUILD_CORES \
      ARCH=wasm32 \
      HOSTCC=${clang-host}/bin/clang \
      CC=${clang}/bin/clang \
      CFLAGS_busybox="${busyboxLdFlags}" \
      CONFIG_PREFIX=$out install

    runHook postInstall
  '';
}
