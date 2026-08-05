{
  buildGoModule,
  busybox,
  go-compat,
  lib,
  pkgs,
  vm-test,
}:

let
  replaceXSys = ''
    chmod -R u+w vendor
    rm -rf vendor/golang.org/x/sys
    mkdir -p vendor/golang.org/x
    cp -r ${go-compat.xSys} vendor/golang.org/x/sys
    chmod -R u+w vendor/golang.org/x/sys

    # go-isatty treats every wasm architecture as a browser-style sandbox.
    # linux/wasm has the ordinary Unix ioctl implementation instead.
    if test -f vendor/github.com/mattn/go-isatty/isatty_others.go; then
      sed -i \
        -e 's/|| wasm ||/|| (wasm \&\& !linux) ||/' \
        -e 's/|| wasm)/|| (wasm \&\& !linux))/' \
        -e 's/ tinygo wasm wasip1/ tinygo wasm,!linux wasip1/' \
        -e 's/ tinygo wasm$/ tinygo wasm,!linux/' \
        vendor/github.com/mattn/go-isatty/isatty_others.go
      grep -q 'wasm && !linux' vendor/github.com/mattn/go-isatty/isatty_others.go
    fi

    azure_runtime=vendor/github.com/Azure/azure-sdk-for-go/sdk/azcore/runtime
    if test -f "$azure_runtime/transport_default_dialer_other.go"; then
      substituteInPlace "$azure_runtime/transport_default_dialer_other.go" \
        --replace-fail '//go:build !wasm' '//go:build !wasm || (linux && wasm)'
    fi

    if test -d vendor/golang.org/x/net/internal/socket; then
      xnet_socket=vendor/golang.org/x/net/internal/socket
      substituteInPlace "$xnet_socket/cmsghdr_linux_32bit.go" \
        --replace-fail 'ppc) && linux' 'ppc || wasm) && linux'
      substituteInPlace "$xnet_socket/iovec_32bit.go" \
        --replace-fail 'ppc) && (darwin' 'ppc || wasm) && (darwin'
      substituteInPlace "$xnet_socket/msghdr_linux_32bit.go" \
        --replace-fail 'ppc) && linux' 'ppc || wasm) && linux'
      substituteInPlace "$xnet_socket/rawconn_mmsg.go" \
        --replace-fail '//go:build linux' '//go:build linux && !wasm'
      substituteInPlace "$xnet_socket/rawconn_nommsg.go" \
        --replace-fail '//go:build !linux' '//go:build !linux || wasm'
      substituteInPlace "$xnet_socket/sys_linux.go" \
        --replace-fail '!s390x && !386' '!s390x && !386 && !wasm'
      substituteInPlace "$xnet_socket/mmsghdr_unix.go" \
        --replace-fail 'aix || linux || netbsd' 'aix || (linux && !wasm) || netbsd'
      install -m644 ${../go-compat/x-net-zsys_linux_wasm.go} \
        "$xnet_socket/zsys_linux_wasm.go"
      cp vendor/golang.org/x/net/ipv4/zsys_linux_arm.go \
        vendor/golang.org/x/net/ipv4/zsys_linux_wasm.go
      cp vendor/golang.org/x/net/ipv6/zsys_linux_arm.go \
        vendor/golang.org/x/net/ipv6/zsys_linux_wasm.go
    fi

    bbolt_common=vendor/go.etcd.io/bbolt/internal/common
    if test -d "$bbolt_common"; then
      install -m644 ${./bbolt_wasm.go} "$bbolt_common/bolt_wasm.go"
    fi
  '';

  mkTests =
    {
      name,
      src,
      packages,
      vendorHash ? null,
    }:
    buildGoModule {
      pname = "go-${name}-tests";
      version = "0.0.0";
      inherit src vendorHash;

      postConfigure = lib.optionalString (name != "x-sys") ''
        ${replaceXSys}
      '';

      buildPhase = ''
        runHook preBuild
        ${lib.concatMapStringsSep "\n" (
          package:
          let
            binary = if package == "." then name else lib.replaceStrings [ "./" "/" ] [ "" "-" ] package;
          in
          "go test -c -ldflags=-buildid= -o ${name}-${binary}.test ${package}"
        ) packages}
        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p $out/bin
        install -m755 *.test $out/bin/
        runHook postInstall
      '';
    };

  libraryTests = {
    x-sys = mkTests {
      name = "x-sys";
      src = go-compat.xSys;
      packages = [ "./unix" ];
    };

    x-term = mkTests {
      name = "x-term";
      src = go-compat.xTerm;
      packages = [ "." ];
      vendorHash = "sha256-zKah7N80wT2ZZIzcw0rjh/gEL6xVxii8CdoT13b9fLY=";
    };

    x-net = mkTests {
      name = "x-net";
      src = go-compat.xNet;
      packages = [
        "./dns/dnsmessage"
        "./http/httpguts"
        "./http/httpproxy"
        "./proxy"
        "./websocket"
      ];
      vendorHash = "sha256-JSklT/mRq/bDEi11Z63v9HkVt9RS+fYuj/lhupMdK3s=";
    };

    x-crypto = mkTests {
      name = "x-crypto";
      src = go-compat.xCrypto;
      packages = [
        "./argon2"
        "./bcrypt"
        "./chacha20poly1305"
        "./ssh"
      ];
      vendorHash = "sha256-BW8Qqz/Fq2SNVV3rBFBozPzDdLLr36SXTxj6ZcdXVdo=";
    };
  };

  applicationTests = {
    yq = mkTests {
      name = "yq";
      src = pkgs.yq-go.src;
      packages = [ "./pkg/yqlib" ];
      vendorHash = pkgs.yq-go.goModules.outputHash;
    };

    age = mkTests {
      name = "age";
      src = pkgs.age.src;
      packages = [ "." ];
      vendorHash = pkgs.age.goModules.outputHash;
    };

    restic = mkTests {
      name = "restic";
      src = pkgs.restic.src;
      packages = [
        "./internal/crypto"
        "./internal/restic"
      ];
      vendorHash = pkgs.restic.goModules.outputHash;
    };

    caddy = mkTests {
      name = "caddy";
      src = pkgs.caddy.src;
      packages = [
        "."
        "./caddyconfig/caddyfile"
      ];
      vendorHash = pkgs.caddy.goModules.outputHash;
    };

    fzf = mkTests {
      name = "fzf";
      src = pkgs.fzf.src;
      packages = [ "./src" ];
      vendorHash = pkgs.fzf.goModules.outputHash;
    };
  };

  tests = libraryTests // applicationTests;

  mkCandidate =
    {
      name,
      upstream,
      subPackages,
      tags ? [ ],
      ldflags ? [
        "-s"
        "-w"
      ],
    }:
    buildGoModule {
      pname = name;
      inherit (upstream) version src;
      vendorHash = upstream.goModules.outputHash;
      inherit
        ldflags
        subPackages
        tags
        ;
      postConfigure = replaceXSys;
    };

  candidates = {
    yq = mkCandidate {
      name = "yq";
      upstream = pkgs.yq-go;
      subPackages = [ "." ];
    };

    age = mkCandidate {
      name = "age";
      upstream = pkgs.age;
      subPackages = [
        "./cmd/age"
        "./cmd/age-keygen"
      ];
    };

    restic = mkCandidate {
      name = "restic";
      upstream = pkgs.restic;
      subPackages = [ "./cmd/restic" ];
    };

    caddy = mkCandidate {
      name = "caddy";
      upstream = pkgs.caddy;
      subPackages = [ "./cmd/caddy" ];
      tags = [
        "nobadger"
        "nomysql"
        "nopgx"
      ];
    };

    fzf = mkCandidate {
      name = "fzf";
      upstream = pkgs.fzf;
      subPackages = [ "." ];
    };
  };

  guestCheck = vm-test.vmTest {
    name = "go-ecosystem";
    initramfs = vm-test.mkInitramfs {
      name = "go-ecosystem";
      init = ./guest-test.sh;
      contents = [ busybox ] ++ lib.attrValues tests ++ lib.attrValues candidates;
    };
  };
in
{
  inherit candidates tests;
  package =
    (pkgs.linkFarm "go-ecosystem-tests" (
      lib.mapAttrsToList (name: path: {
        name = "test-${name}";
        inherit path;
      }) tests
      ++ lib.mapAttrsToList (name: path: {
        name = "candidate-${name}";
        inherit path;
      }) candidates
    )).overrideAttrs
      (_: {
        passthru.checks.guest = guestCheck;
      });
  recurseForDerivations = true;
}
