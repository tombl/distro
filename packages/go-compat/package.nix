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
        cp zerrors_linux_386.go zerrors_linux_wasm.go
        substituteInPlace zerrors_linux_wasm.go \
          --replace-fail '386 && linux' 'wasm && linux'
        cp zsysnum_linux_arm64.go zsysnum_linux_wasm.go
        substituteInPlace zsysnum_linux_wasm.go \
          --replace-fail 'arm64 && linux' 'wasm && linux'

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
        substituteInPlace ztypes_linux_wasm.go \
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

        cp syscall_linux_arm64.go syscall_linux_wasm.go
        substituteInPlace syscall_linux_wasm.go \
          --replace-fail 'arm64 && linux' 'wasm && linux' \
          --replace-fail 'Nsec: timeout.Usec * 1000' 'Nsec: int32(timeout.Usec * 1000)' \
          --replace-fail 'Nsec: nsec}' 'Nsec: int32(nsec)}' \
          --replace-fail 'func (r *PtraceRegs) PC() uint64 { return r.Pc }' "" \
          --replace-fail 'func (r *PtraceRegs) SetPC(pc uint64) { r.Pc = pc }' "" \
          --replace-fail 'iov.Len = uint64(length)' 'iov.Len = uint32(length)' \
          --replace-fail 'msghdr.Controllen = uint64(length)' 'msghdr.Controllen = uint32(length)' \
          --replace-fail 'msghdr.Iovlen = uint64(length)' 'msghdr.Iovlen = int32(length)' \
          --replace-fail 'cmsg.Len = uint64(length)' 'cmsg.Len = uint32(length)' \
          --replace-fail 'rsa.Service_name_len = uint64(length)' 'rsa.Service_name_len = uint32(length)'

        # fanotifyMark's uint64 mask makes its generated calling sequence
        # architecture-specific, so it is absent from the merged Linux file.
        printf '\n//sys\tfanotifyMark(fd int, flags uint, mask uint64, dirFd int, pathname *byte) (err error)\n' \
          >> syscall_linux_wasm.go
        printf '//sys\tFallocate(fd int, mode uint32, off int64, len int64) (err error)\n' \
          >> syscall_linux_wasm.go
        printf '//sys\tTee(rfd int, wfd int, len int, flags int) (n int64, err error)\n' \
          >> syscall_linux_wasm.go

        # wasm forwards raw calls through the forked standard syscall package;
        # the architecture assembly shims used elsewhere cannot express the
        # wasm host-call instruction sequence.
        substituteInPlace syscall_unix_gc.go \
          --replace-fail '(linux && !ppc64 && !ppc64le)' '(linux && !ppc64 && !ppc64le && !wasm)'
        substituteInPlace syscall_linux_gc.go \
          --replace-fail 'linux && gc' 'linux && gc && !wasm'
        install -m644 ${./syscall_gc_wasm.go} syscall_gc_wasm.go

        env -u GOOS -u GOARCH GOOS_TARGET=linux GOLANG_SYS_BUILD=docker \
          go run mksyscall.go -tags linux,wasm syscall_linux_wasm.go \
          > zsyscall_linux_wasm.go

        gofmt -w syscall_linux_wasm.go syscall_gc_wasm.go \
          ztypes_linux_wasm.go zsyscall_linux_wasm.go
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
