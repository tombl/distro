# Exact compatibility source for the foundational golang.org/x modules. The
# wasm Linux Go port has a deliberately unusual split ABI: Go pointers are
# 64-bit, while the kernel and musl structures are ILP32. Generate x/sys types
# from the distro headers with cgo's 32-bit type reader, but compile and run the
# resulting package with the normal 64-bit-pointer Go wasm architecture.
{
  pkgs,
  go-toolchain,
  sysroot,
}:

let
  xSysUpstream = pkgs.fetchFromGitHub {
    owner = "golang";
    repo = "sys";
    rev = "v0.47.0";
    hash = "sha256-St0+knON6NE8ApWfjOjzw4O8wInQ23f1bNRy7pp2Vpo=";
  };

  generationCC = "${pkgs.llvmPackages.clang-unwrapped}/bin/clang";

  xSys =
    pkgs.runCommand "golang-x-sys-0.47.0-wasm-linux"
      {
        nativeBuildInputs = [
          go-toolchain.package
          pkgs.bash
          pkgs.gawk
          pkgs.gnused
          pkgs.patch
        ];
      }
      ''
        cp -r ${xSysUpstream} $out
        chmod -R u+w $out
        patch --ignore-whitespace -p1 -d $out < ${./x-sys-types-wasm.patch}
        substituteInPlace $out/unix/linux/types.go \
          --replace-fail 'defined(__aarch64__) || (defined(__mips__)' 'defined(__aarch64__) || defined(__wasm__) || (defined(__mips__)'
        substituteInPlace $out/cpu/cpu_linux.go \
          --replace-fail '!arm64' '!arm64 && !wasm'
        cd $out/unix
        export HOME=$TMPDIR
        export GOCACHE=$TMPDIR/go-cache
        mkdir -p linux/abi
        for bit in $(seq 0 63); do
          printf '#define BITFIELD_MASK_%s (1ULL << %s)\n' "$bit" "$bit"
        done > linux/abi/abi.h

        # wasm uses asm-generic syscall numbers and the ILP32 Linux constant
        # encodings. The descriptions and generated wrappers are architecture
        # neutral; the type file below comes from the actual distro headers.
        #
        # Timespec and Timeval follow musl's time64 layout, so the socket
        # timeout and timestamp options are musl's time64 values, which select
        # the kernel's 64-bit timeval variants. This source tree is only
        # compiled for linux/wasm, so the shared SO_TIMESTAMP can change too.
        cp zerrors_linux_386.go zerrors_linux_wasm.go
        substituteInPlace zerrors_linux_wasm.go \
          --replace-fail '386 && linux' 'wasm && linux' \
          --replace-fail 'SO_RCVTIMEO                      = 0x14' 'SO_RCVTIMEO                      = 0x42' \
          --replace-fail 'SO_SNDTIMEO                      = 0x15' 'SO_SNDTIMEO                      = 0x43' \
          --replace-fail 'SO_TIMESTAMPNS                   = 0x23' 'SO_TIMESTAMPNS                   = 0x40' \
          --replace-fail 'SO_TIMESTAMPING                  = 0x25' 'SO_TIMESTAMPING                  = 0x41' \
          --replace-fail 'SCM_TIMESTAMPNS                  = 0x23' 'SCM_TIMESTAMPNS                  = 0x40' \
          --replace-fail 'SCM_TIMESTAMPING                 = 0x25' 'SCM_TIMESTAMPING                 = 0x41'
        substituteInPlace zerrors_linux.go \
          --replace-fail 'SO_TIMESTAMP                                = 0x1d' 'SO_TIMESTAMP                                = 0x3f' \
          --replace-fail 'SCM_TIMESTAMP                               = 0x1d' 'SCM_TIMESTAMP                               = 0x3f'
        # The asm-generic numbers are shared with arm64. Add the entries only
        # 32-bit targets have.
        cp zsysnum_linux_arm64.go zsysnum_linux_wasm.go
        substituteInPlace zsysnum_linux_wasm.go \
          --replace-fail 'arm64 && linux' 'wasm && linux'
        cat >>zsysnum_linux_wasm.go <<'SYSNUM'

        const (
        	SYS_SYNC_FILE_RANGE2             = 84
        	SYS_CLOCK_GETTIME64              = 403
        	SYS_CLOCK_SETTIME64              = 404
        	SYS_CLOCK_ADJTIME64              = 405
        	SYS_CLOCK_GETRES_TIME64          = 406
        	SYS_CLOCK_NANOSLEEP_TIME64       = 407
        	SYS_TIMER_GETTIME64              = 408
        	SYS_TIMER_SETTIME64              = 409
        	SYS_TIMERFD_GETTIME64            = 410
        	SYS_TIMERFD_SETTIME64            = 411
        	SYS_UTIMENSAT_TIME64             = 412
        	SYS_PSELECT6_TIME64              = 413
        	SYS_PPOLL_TIME64                 = 414
        	SYS_IO_PGETEVENTS_TIME64         = 416
        	SYS_RECVMMSG_TIME64              = 417
        	SYS_MQ_TIMEDSEND_TIME64          = 418
        	SYS_MQ_TIMEDRECEIVE_TIME64       = 419
        	SYS_SEMTIMEDOP_TIME64            = 420
        	SYS_RT_SIGTIMEDWAIT_TIME64       = 421
        	SYS_FUTEX_TIME64                 = 422
        	SYS_SCHED_RR_GET_INTERVAL_TIME64 = 423
        )
        SYSNUM

          # cgo cannot decode a wasm object even in -godefs mode. Generate an ELF
          # object with the equivalent little-endian ILP32 data model and 8-byte
          # i64 alignment, while preprocessing the distro's actual wasm headers.
          # GOARCH_TARGET keeps mkpost's architecture cleanups on wasm.
          GOOS=linux GOARCH=arm GOARCH_TARGET=wasm CGO_ENABLED=1 CC=${generationCC} \
            go tool cgo -godefs -- -Wall '-Wno-error=#warnings' -static \
              --target=armv7-none-linux-gnueabihf --sysroot=${sysroot} \
              -U__arm__ -U__ARM_EABI__ -D__wasm__=1 \
              -fsigned-char '-D__SIZE_TYPE__=long unsigned int' \
              -I$PWD/linux linux/types.go \
            | env -u GOOS -u GOARCH GOOS_TARGET=linux GOARCH_TARGET=wasm \
              GOLANG_SYS_BUILD=docker go run mkpost.go \
            > ztypes_linux_wasm.go
          rm ztypes_linux.go

        # cgo cannot name musl's deliberately opaque struct stat after the
        # synthetic target has had its ARM identity removed. Its layout is
        # nevertheless a stable part of the wasm-linux ABI and is shared with
        # the standard library port.
        #
        # BlkpgIoctlArg is the one exported kernel structure with a pointer
        # that no wrapper marshals. Go cannot place a 64-bit pointer at the
        # kernel's ILP32 offset, so expose the 32-bit address instead: code
        # that stores a Go pointer there fails to compile rather than passing
        # the kernel padding.
        substituteInPlace ztypes_linux_wasm.go \
          --replace-fail '	Data    *byte' '	Data    uint32 // ILP32 address of the payload' \
          --replace-fail 'type Stat_t _cgopackage.Incomplete' 'type Stat_t struct {
              Dev       uint64
              Ino       uint64
              Mode      uint32
              Nlink     uint32
              Uid       uint32
              Gid       uint32
              Rdev      uint64
              X__pad    uint64
              Size      int64
              Blksize   int32
              X__pad2   int32
              Blocks    int64
              Atim      Timespec
              Mtim      Timespec
              Ctim      Timespec
              X__unused [2]uint32
          }'

        substituteInPlace endian_little.go \
          --replace-fail '386 || amd64' '386 || wasm || amd64'

        install -m644 ${./x-sys-syscall-linux-wasm.go} syscall_linux_wasm.go

        # wasm forwards raw calls through the forked standard syscall package;
        # the architecture assembly shims used elsewhere cannot express the
        # wasm host-call instruction sequence.
        substituteInPlace syscall_unix_gc.go \
          --replace-fail '(linux && !ppc64 && !ppc64le)' '(linux && !ppc64 && !ppc64le && !wasm)'
        substituteInPlace syscall_linux_gc.go \
          --replace-fail 'linux && gc' 'linux && gc && !wasm'
        install -m644 ${./syscall_gc_wasm.go} syscall_gc_wasm.go

        # The kernel takes i386-style 32-bit slots: split 64-bit arguments.
        env -u GOOS -u GOARCH GOOS_TARGET=linux GOLANG_SYS_BUILD=docker \
          go run mksyscall.go -l32 -tags linux,wasm syscall_linux_wasm.go \
          > zsyscall_linux_wasm.go

        # The merged Linux wrappers pass Go-native structs straight to the
        # kernel. Calls whose structures contain time64 values switch to the
        # *_time64 entries. Calls with pointer-carrying structures, or with
        # structures the kernel only offers in a time32 layout, are renamed
        # out of the way; syscall_linux_wasm.go and x_sys_vector_wasm.go
        # provide marshalling replacements.
        substituteInPlace zsyscall_linux.go \
          --replace-fail 'Syscall(SYS_CLOCK_GETRES,' 'Syscall(SYS_CLOCK_GETRES_TIME64,' \
          --replace-fail 'Syscall(SYS_CLOCK_GETTIME,' 'Syscall(SYS_CLOCK_GETTIME64,' \
          --replace-fail 'Syscall(SYS_CLOCK_SETTIME,' 'Syscall(SYS_CLOCK_SETTIME64,' \
          --replace-fail 'Syscall6(SYS_CLOCK_NANOSLEEP,' 'Syscall6(SYS_CLOCK_NANOSLEEP_TIME64,' \
          --replace-fail 'Syscall6(SYS_UTIMENSAT,' 'Syscall6(SYS_UTIMENSAT_TIME64,' \
          --replace-fail 'Syscall(SYS_TIMERFD_GETTIME,' 'Syscall(SYS_TIMERFD_GETTIME64,' \
          --replace-fail 'Syscall6(SYS_TIMERFD_SETTIME,' 'Syscall6(SYS_TIMERFD_SETTIME64,' \
          --replace-fail 'func readv(' 'func readvUnmarshaled(' \
          --replace-fail 'func writev(' 'func writevUnmarshaled(' \
          --replace-fail 'func preadvSyscall(' 'func preadvSyscallUnmarshaled(' \
          --replace-fail 'func pwritevSyscall(' 'func pwritevSyscallUnmarshaled(' \
          --replace-fail 'func preadv2Syscall(' 'func preadv2SyscallUnmarshaled(' \
          --replace-fail 'func pwritev2Syscall(' 'func pwritev2SyscallUnmarshaled(' \
          --replace-fail 'func keyctlIOV(' 'func keyctlIOVUnmarshaled(' \
          --replace-fail 'func ProcessVMReadv(' 'func processVMReadvUnmarshaled(' \
          --replace-fail 'func ProcessVMWritev(' 'func processVMWritevUnmarshaled(' \
          --replace-fail 'func ppoll(' 'func ppollUnmarshaled(' \
          --replace-fail 'func pselect6(' 'func pselect6Unmarshaled(' \
          --replace-fail 'func Nanosleep(' 'func nanosleepTime32(' \
          --replace-fail 'func Settimeofday(' 'func settimeofdayTime32(' \
          --replace-fail 'func Adjtimex(' 'func adjtimexTime32(' \
          --replace-fail 'func ClockAdjtime(' 'func clockAdjtimeTime32(' \
          --replace-fail 'func Getrusage(' 'func getrusageUnmarshaled(' \
          --replace-fail 'func wait4(' 'func wait4Unmarshaled(' \
          --replace-fail 'func Waitid(' 'func waitidUnmarshaled(' \
          --replace-fail 'func getitimer(' 'func getitimerTime32(' \
          --replace-fail 'func setitimer(' 'func setitimerTime32('
        substituteInPlace syscall_linux.go \
          --replace-fail 'func Vmsplice(' 'func vmspliceUnmarshaled(' \
          --replace-fail 'func SetsockoptSockFprog(' 'func setsockoptSockFprogUnmarshaled('
        install -m644 ${./x-sys-vector-wasm.go} x_sys_vector_wasm.go
        install -m644 ${./x-sys-abi-wasm_test.go} wasm_abi_linux_test.go

        gofmt -w syscall_linux_wasm.go syscall_gc_wasm.go \
          ztypes_linux_wasm.go zsyscall_linux_wasm.go x_sys_vector_wasm.go \
          zsysnum_linux_wasm.go
      '';

  xTerm = pkgs.fetchFromGitHub {
    owner = "golang";
    repo = "term";
    rev = "v0.45.0";
    hash = "sha256-vPBeJkepEZ1D9k4oaV20IuQlVmfAFv15KQgnhl9MNgw=";
  };

  xNetUpstream = pkgs.fetchFromGitHub {
    owner = "golang";
    repo = "net";
    rev = "v0.57.0";
    hash = "sha256-gKo8UMw4hfETBHm8N5GOfuNadse9TWEQXJo2YWq5bY4=";
  };

  xNet = pkgs.runCommand "golang-x-net-0.57.0-wasm-linux" { } ''
    cp -r ${xNetUpstream} $out
    chmod -R u+w $out
    substituteInPlace $out/internal/socket/cmsghdr_linux_32bit.go \
      --replace-fail 'ppc) && linux' 'ppc || wasm) && linux'
    substituteInPlace $out/internal/socket/iovec_32bit.go \
      --replace-fail 'ppc) && (darwin' 'ppc || wasm) && (darwin'
    substituteInPlace $out/internal/socket/msghdr_linux_32bit.go \
      --replace-fail 'ppc) && linux' 'ppc || wasm) && linux'
    substituteInPlace $out/internal/socket/rawconn_mmsg.go \
      --replace-fail '//go:build linux' '//go:build linux && !wasm'
    substituteInPlace $out/internal/socket/rawconn_nommsg.go \
      --replace-fail '//go:build !linux' '//go:build !linux || wasm'
    substituteInPlace $out/internal/socket/sys_linux.go \
      --replace-fail '!s390x && !386' '!s390x && !386 && !wasm'
    substituteInPlace $out/internal/socket/mmsghdr_unix.go \
      --replace-fail 'aix || linux || netbsd' 'aix || (linux && !wasm) || netbsd'
    install -m644 ${./x-net-zsys_linux_wasm.go} \
      $out/internal/socket/zsys_linux_wasm.go
    cp $out/ipv4/zsys_linux_arm.go $out/ipv4/zsys_linux_wasm.go
    cp $out/ipv6/zsys_linux_arm.go $out/ipv6/zsys_linux_wasm.go
  '';

  xCrypto = pkgs.fetchFromGitHub {
    owner = "golang";
    repo = "crypto";
    rev = "v0.54.0";
    hash = "sha256-7dZVbrJ4lVKThJWaOGc4bJTdzJBlRLAx/vSHeWFyor8=";
  };
in
{
  package = xSys;
  inherit
    xCrypto
    xNet
    xSys
    xTerm
    ;
}
