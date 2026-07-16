{
  pkgs,
  stdenv,
  lib,
  debug,
  linux,
  platform,
  src,
  vm-test,
}:

let
  package = stdenv.mkDerivation (finalAttrs: {
    name = "busybox";
    inherit src;

    # busybox builds host tools with HOSTCC during the target build.
    depsBuildBuild = [ pkgs.stdenv.cc ];

    # The rootfs ships this FHS tree as-is; keep sbin a real directory.
    dontMoveSbin = true;

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

      make -j$NIX_BUILD_CORES defconfig
      config STATIC y
      config NOMMU y
      config STATIC_LIBGCC n
      config CROSS_COMPILER_PREFIX llvm-
      config EXTRA_CFLAGS '-I${linux.headers}/include ${lib.optionalString debug "-g"}'
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

      make -j$NIX_BUILD_CORES oldconfig

      runHook postConfigure
    '';

    # busybox partial-links object files with `$CC -r`, where executable
    # flags like --export-table are invalid, so the stdenv default is opted
    # out of and the flags applied to the final binary only.
    linkerFlags = lib.concatMapStringsSep " " (flag: "-Wl,${flag}") platform.linkerFlags;

    buildPhase = ''
      runHook preBuild
      unset NIX_CFLAGS_LINK
      make -j$NIX_BUILD_CORES CC="$CC" HOSTCC="$CC_FOR_BUILD" CFLAGS_busybox="$linkerFlags" ${lib.optionalString debug "SKIP_STRIP=y"}
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      make -j$NIX_BUILD_CORES CC="$CC" HOSTCC="$CC_FOR_BUILD" CFLAGS_busybox="$linkerFlags" CONFIG_PREFIX=$out install
      runHook postInstall
    '';

    passthru.checks.smoke = vm-test.vmTest {
      name = "busybox-smoke";
      initramfs = vm-test.mkInitramfs {
        name = "busybox-smoke";
        init = ./smoke-test.sh;
        contents = [ finalAttrs.finalPackage ];
      };
    };
  });
in
package
