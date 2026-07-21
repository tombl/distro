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
    basic-init = callPackage ./basic-init/package.nix { };
    busybox = callPackage ./busybox/package.nix { src = inputs.busybox-src; };

    # Early platform tests boot without the guest agent so a broken SDK cannot
    # hide whether the kernel and libc reached userspace correctly.
    vm-test = callPackage ./vm-test/package.nix { };

    # Shared immutable filesystem construction. Product-specific images remain
    # owned by their consumer packages.
    image = callPackage ./image { };

    # The private guest protocol and its JavaScript SDK ship together.
    guest-agent = callPackage ./guest-agent/package.nix { };
    node-workspace = callPackage ./node-workspace.nix { };
    linux-guest = callPackage ./linux-guest { };
    runner = callPackage ./runner { };
    browser-tests = callPackage ./browser-tests/package.nix { };
  }
)
