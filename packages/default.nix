# The wasm32 package scope. This attrset is the product: consumers import it,
# build their own packages with `callPackage`, and replace or extend members
# with `overrideScope`.
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
    basic-init = callPackage ./basic-init/package.nix { };
    busybox = callPackage ./busybox/package.nix { src = inputs.busybox-src; };
    bzip2 = callPackage ./bzip2/package.nix { src = inputs.bzip2-src; };
    file = callPackage ./file/package.nix { src = inputs.file-src; };
    grep = callPackage ./grep/package.nix { src = inputs.grep-src; };
    guest-agent = callPackage ./guest-agent/package.nix { };
    jq = callPackage ./jq/package.nix { src = inputs.jq-src; };
    lua = callPackage ./lua/package.nix { src = inputs.lua-src; };
    ncurses = callPackage ./ncurses/package.nix { src = inputs.ncurses-src; };
    readline = callPackage ./readline/package.nix { src = inputs.readline-src; };
    sed = callPackage ./sed/package.nix { src = inputs.sed-src; };
    sqlite3 = callPackage ./sqlite3/package.nix { src = inputs.sqlite-src; };
    xz = callPackage ./xz/package.nix { src = inputs.xz-src; };
    zlib = callPackage ./zlib/package.nix { src = inputs.zlib-src; };
    zstd = callPackage ./zstd/package.nix { src = inputs.zstd-src; };

    # images:
    guest-initramfs = callPackage ./guest-initramfs/package.nix { };
    guest-rootfs = callPackage ./guest-rootfs/package.nix { };
    initramfs = callPackage ./initramfs/package.nix { };
    mkRootfs = callPackage ./rootfs-builder/package.nix { };
    rootfs = callPackage ./rootfs/package.nix { };
    site-rootfs = callPackage ./site/rootfs.nix { };

    # host tools and tests:
    node-workspace = callPackage ./node-workspace.nix { };
    linux-guest = callPackage ./linux-guest/package.nix { };
    runner = callPackage ./runner/package.nix { };
    site = callPackage ./site/package.nix { };
    vm-test = callPackage ./vm-test/package.nix { };
  }
)
