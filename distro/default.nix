# The wasm32 package scope. This attrset is the product: consumers import it,
# build their own packages with `callPackage`, and replace or extend members
# with `overrideScope`. Product-owned artifacts are nested under their owner;
# `mkImage` is the one shared image constructor and `vm-test` the shared guest
# test harness.
#
# Dependency provenance is explicit: build-platform packages come from `pkgs.*`,
# wasm packages come from the scope by bare name. Inside the scope, `stdenv`
# targets wasm32-unknown-linux-musl, so a package written for this scope looks
# exactly like a nixpkgs package.
{
  pkgs,
  debug ? false,
  sourceVersion ? "0",
}:

let
  inherit (pkgs) lib;
in

lib.makeScope (scope: lib.callPackageWith ({ inherit lib pkgs; } // scope)) (
  self:
  let
    inherit (self) callPackage;
    # The APK package, repository, and system-install machinery. It is private:
    # images go through mkImage, and only the published repository and its
    # checks index packages directly.
    apk = callPackage ./apk {
      tools = self.apk-tools-host;
    };
  in
  {
    inherit debug sourceVersion;
    platform = callPackage ./platform.nix { };
    apk-tools-src = callPackage ./apk-tools/source.nix { };
    apk-tools-host = pkgs.apk-tools.overrideAttrs (_old: {
      version = "3.0.5";
      src = self.apk-tools-src;
    });

    # The toolchain bootstrap. These build with the build platform's stdenv and
    # explicit flags because they exist to produce the wasm stdenv below; they
    # must not consume it.
    llvm-toolchain-unwrapped = callPackage ./llvm-toolchain/unwrapped.nix {
    };
    llvm-runtimes = callPackage ./llvm-runtimes/package.nix { };
    llvm-toolchain = callPackage ./llvm-toolchain/package.nix { };
    linux = callPackage ./linux/package.nix { };
    bytes = callPackage ./npm/bytes.nix { };
    kernel = callPackage ./npm/kernel.nix { };
    musl = callPackage ./musl/package.nix { };
    sysroot-base = callPackage ./sysroot-base/package.nix { };
    sysroot = callPackage ./sysroot/package.nix { };

    # The wasm stdenv: nixpkgs' generic stdenv with a cc-wrapped fork toolchain
    # and wasm32-unknown-linux-musl as the host platform. Everything below here
    # is an ordinary nixpkgs-style package.
    stdenv = if debug then self.stdenvDebug else self.stdenvRelease;
    # Imported rather than callPackaged: callPackage's makeOverridable would
    # shadow the stdenv's own `.override`, which the debug adapter needs.
    stdenvRelease = import ./stdenv.nix {
      inherit pkgs;
      inherit (self) platform llvm-toolchain sysroot;
    };
    stdenvDebug = pkgs.stdenvAdapters.keepDebugInfo self.stdenvRelease;

    # The C/C++ porting SDK: the stdenv's toolchain and platform knowledge for
    # builds outside Nix, exposed as the flake's `sdk` devshell.
    sdk = callPackage ./sdk/package.nix { };

    # rustc from source on the fork LLVM, with the wasm Linux targets in-tree.
    rustc-wasm-linux = callPackage ./rustc/package.nix { };
    # A pinned nightly rustc with a from-source std for the wasm target.
    rust-toolchain = callPackage ./rust-toolchain/package.nix { };
    rust-compat = callPackage ./rust-compat/package.nix { };
    rust-crate-patches = callPackage ./rust-crate-patches/package.nix { };
    rustPlatform = callPackage ./rust-platform/package.nix { };
    rust-cli-matrix = callPackage ./rust-cli-matrix/package.nix { };

    # userland:
    apk-tools = callPackage ./apk-tools/package.nix {
      src = self.apk-tools-src;
    };
    bash = callPackage ./bash/package.nix { };
    basic-init = callPackage ./basic-init/package.nix { };
    busybox = callPackage ./busybox/package.nix { };
    bzip2 = callPackage ./bzip2/package.nix { };
    ca-certificates = callPackage ./ca-certificates/package.nix { };
    coreutils = callPackage ./coreutils/package.nix { };
    curl = callPackage ./curl/package.nix { };
    diffutils = callPackage ./diffutils/package.nix { };
    dropbear = callPackage ./dropbear/package.nix { };
    e2fsprogs = callPackage ./e2fsprogs/package.nix { };
    erofs-utils = callPackage ./erofs-utils/package.nix { };
    file = callPackage ./file/package.nix { };
    findutils = callPackage ./findutils/package.nix { };
    gawk = callPackage ./gawk/package.nix { };
    git = callPackage ./git/package.nix { };
    grep = callPackage ./grep/package.nix { };
    jq = callPackage ./jq/package.nix { };
    less = callPackage ./less/package.nix { };
    lua = callPackage ./lua/package.nix { };
    make = callPackage ./make/package.nix { };
    ncurses = callPackage ./ncurses/package.nix { };
    openssl = callPackage ./openssl/package.nix { };
    patch = callPackage ./patch/package.nix { };
    python = callPackage ./python/package.nix { };
    quickjs = callPackage ./quickjs/package.nix { };
    readline = callPackage ./readline/package.nix { };
    rust-smoke = callPackage ./rust-smoke/package.nix { };
    sed = callPackage ./sed/package.nix { };
    sqlite3 = callPackage ./sqlite3/package.nix { };
    tar = callPackage ./tar/package.nix { };
    util-linux = callPackage ./util-linux/package.nix { };
    vim = callPackage ./vim/package.nix { };
    xz = callPackage ./xz/package.nix { };
    zlib = callPackage ./zlib/package.nix { };
    zstd = callPackage ./zstd/package.nix { };

    # Early platform tests boot without the guest agent so a broken SDK cannot
    # hide whether the kernel and libc reached userspace correctly.
    vm-test = callPackage ./vm-test/package.nix { };

    # The image constructor; see image/default.nix for its arguments. It
    # resolves package dependencies by name against this (final) scope.
    mkImage = callPackage ./image {
      inherit apk;
      scope = self;
    };

    site = callPackage ./site { };
    bridge-site = callPackage ../packages/bridge-site { };

    apk-checks = callPackage ./apk/checks.nix { inherit apk; };
    image-checks = callPackage ./image/checks.nix { };
    repository =
      (callPackage ./repository.nix {
        inherit apk;
        bootFiles = self.site.bootFiles;
      })
      // {
        checks = {
          inherit (self.apk-checks) install store-references userland;
          image-resolver = self.image-checks.resolver;
        };
      };

    # The private guest protocol and its JavaScript SDK ship together.
    guest-agent = callPackage ./guest-agent/package.nix { };
    ltp = callPackage ./ltp/package.nix { };
    kselftests = callPackage ./kselftests/package.nix { };
    node-workspace = callPackage ./npm/node-workspace.nix { };
    playwright = callPackage ./npm/playwright.nix { };
    linux-guest = callPackage ./npm/linux-guest { };
    runner = callPackage ./npm/runner { };
    browser-tests = callPackage ./npm/browser-tests.nix { };
  }
)
