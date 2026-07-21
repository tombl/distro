# The wasm32 package scope. This attrset is the product: consumers import it,
# build their own packages with `callPackage`, and replace or extend members
# with `overrideScope`. Product-owned artifacts are nested under their owner;
# shared construction machinery lives under `image` and `vm-test`.
#
# Dependency provenance is explicit: build-platform packages come from `pkgs.*`,
# wasm packages come from the scope by bare name. Inside the scope, `stdenv`
# targets wasm32-unknown-linux-musl, so a package written for this scope looks
# exactly like a nixpkgs package.
{
  pkgs,
  inputs,
  debug ? false,
}:

let
  inherit (pkgs) lib;
in

lib.makeScope (scope: lib.callPackageWith ({ inherit lib pkgs; } // scope)) (
  self:
  let
    inherit (self) callPackage;
  in
  {
    inherit debug;
    platform = callPackage ./platform.nix { };

    # The toolchain bootstrap. These build with the build platform's stdenv and
    # explicit flags because they exist to produce the wasm stdenv below; they
    # must not consume it.
    llvm-toolchain-unwrapped = callPackage ./llvm-toolchain/unwrapped.nix {
      src = inputs.llvm-src;
    };
    llvm-runtimes = callPackage ./llvm-runtimes/package.nix { src = inputs.llvm-src; };
    llvm-toolchain = callPackage ./llvm-toolchain/package.nix { };
    linux = callPackage ./linux/package.nix { src = inputs.linux-src; };
    musl = callPackage ./musl/package.nix { src = inputs.musl-src; };
    sysroot-base = callPackage ./sysroot-base/package.nix { };
    sysroot = callPackage ./sysroot/package.nix { };

    # The wasm stdenv: nixpkgs' generic stdenv with a cc-wrapped fork toolchain
    # and wasm32-unknown-linux-musl as the host platform. Everything below here
    # is an ordinary nixpkgs-style package.
    stdenv = if debug then self.stdenvDebug else self.stdenvRelease;
    # Imported rather than callPackaged: callPackage's makeOverridable would
    # shadow the stdenv's own `.override`, which the adapters below need.
    stdenvRelease = import ./stdenv.nix {
      inherit pkgs;
      inherit (self) platform llvm-toolchain sysroot;
    };
    stdenvDebug = pkgs.stdenvAdapters.keepDebugInfo self.stdenvRelease;

    # userland:
    bash = callPackage ./bash/package.nix { src = inputs.bash-src; };
    basic-init = callPackage ./basic-init/package.nix { };
    busybox = callPackage ./busybox/package.nix { src = inputs.busybox-src; };
    bzip2 = callPackage ./bzip2/package.nix { src = inputs.bzip2-src; };
    coreutils = callPackage ./coreutils/package.nix { src = inputs.coreutils-src; };
    curl = callPackage ./curl/package.nix { src = inputs.curl-src; };
    diffutils = callPackage ./diffutils/package.nix { src = inputs.diffutils-src; };
    dropbear = callPackage ./dropbear/package.nix { src = inputs.dropbear-src; };
    file = callPackage ./file/package.nix { src = inputs.file-src; };
    findutils = callPackage ./findutils/package.nix { src = inputs.findutils-src; };
    gawk = callPackage ./gawk/package.nix { src = inputs.gawk-src; };
    git = callPackage ./git/package.nix { src = inputs.git-src; };
    grep = callPackage ./grep/package.nix { src = inputs.grep-src; };
    jq = callPackage ./jq/package.nix { src = inputs.jq-src; };
    less = callPackage ./less/package.nix { src = inputs.less-src; };
    lua = callPackage ./lua/package.nix { src = inputs.lua-src; };
    make = callPackage ./make/package.nix { src = inputs.make-src; };
    mbedtls = callPackage ./mbedtls/package.nix { src = inputs.mbedtls-src; };
    ncurses = callPackage ./ncurses/package.nix { src = inputs.ncurses-src; };
    openssl = callPackage ./openssl/package.nix { src = inputs.openssl-src; };
    patch = callPackage ./patch/package.nix { src = inputs.patch-src; };
    python = callPackage ./python/package.nix { src = inputs.python-src; };
    quickjs = callPackage ./quickjs/package.nix { src = inputs.quickjs-src; };
    readline = callPackage ./readline/package.nix { src = inputs.readline-src; };
    sed = callPackage ./sed/package.nix { src = inputs.sed-src; };
    sqlite3 = callPackage ./sqlite3/package.nix { src = inputs.sqlite-src; };
    tar = callPackage ./tar/package.nix { src = inputs.tar-src; };
    util-linux = callPackage ./util-linux/package.nix { src = inputs.util-linux-src; };
    vim = callPackage ./vim/package.nix { src = inputs.vim-src; };
    xz = callPackage ./xz/package.nix { src = inputs.xz-src; };
    zlib = callPackage ./zlib/package.nix { src = inputs.zlib-src; };
    zstd = callPackage ./zstd/package.nix { src = inputs.zstd-src; };

    # Early platform tests boot without the guest agent so a broken SDK cannot
    # hide whether the kernel and libc reached userspace correctly.
    vm-test = callPackage ./vm-test/package.nix { };

    # Shared immutable filesystem construction. Product-specific images remain
    # owned by their consumer packages.
    image = callPackage ./image { };

    # The private guest protocol and its JavaScript SDK ship together.
    guest-agent = callPackage ./guest-agent/package.nix { };
    kselftests = callPackage ./kselftests/package.nix { src = inputs.linux-src; };
    ltp = callPackage ./ltp/package.nix { src = inputs.ltp-src; };
    node-workspace = callPackage ./node-workspace.nix { };
    linux-guest = callPackage ./linux-guest { };
    runner = callPackage ./runner { };
    browser-tests = callPackage ./browser-tests/package.nix { };
  }
)
