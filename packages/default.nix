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
  debug ? false,
}:

let
  inherit (pkgs) lib;
in

lib.makeScope (scope: lib.callPackageWith ({ inherit lib pkgs; } // scope)) (
  self:
  let
    inherit (self) callPackage;
    mainRepository = callPackage ./repositories/main.nix { };
  in
  {
    inherit debug;
    platform = callPackage ./platform.nix { };
    apk-tools-src = callPackage ./apk-tools/source.nix { };
    apk-tools-host = pkgs.apk-tools.overrideAttrs (_old: {
      version = "3.0.5";
      src = self.apk-tools-src;
    });
    apk = callPackage ./apk {
      tools = self.apk-tools-host;
    };

    # The toolchain bootstrap. These build with the build platform's stdenv and
    # explicit flags because they exist to produce the wasm stdenv below; they
    # must not consume it.
    llvm-toolchain-unwrapped = callPackage ./llvm-toolchain/unwrapped.nix {
    };
    llvm-runtimes = callPackage ./llvm-runtimes/package.nix { };
    llvm-toolchain = callPackage ./llvm-toolchain/package.nix { };
    linux = callPackage ./linux/package.nix { };
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

    # A pinned nightly rustc with a from-source std for the wasm target.
    rust-toolchain = callPackage ./rust-toolchain/package.nix { };

    # userland:
    apk-tools = callPackage ./apk-tools/package.nix {
      src = self.apk-tools-src;
    };
    basic-init = callPackage ./basic-init/package.nix { };
    busybox = callPackage ./busybox/package.nix { };
    bzip2 = callPackage ./bzip2/package.nix { };
    ca-certificates = callPackage ./ca-certificates/package.nix { };
    curl = callPackage ./curl/package.nix { };
    dropbear = callPackage ./dropbear/package.nix { };
    file = callPackage ./file/package.nix { };
    git = callPackage ./git/package.nix { };
    jq = callPackage ./jq/package.nix { };
    lua = callPackage ./lua/package.nix { };
    make = callPackage ./make/package.nix { };
    ncurses = callPackage ./ncurses/package.nix { };
    openssl = callPackage ./openssl/package.nix { };
    python = callPackage ./python/package.nix { };
    quickjs = callPackage ./quickjs/package.nix { };
    readline = callPackage ./readline/package.nix { };
    rust-smoke = callPackage ./rust-smoke/package.nix { };
    sqlite3 = callPackage ./sqlite3/package.nix { };
    xz = callPackage ./xz/package.nix { };
    zlib = callPackage ./zlib/package.nix { };
    zstd = callPackage ./zstd/package.nix { };

    # Early platform tests boot without the guest agent so a broken SDK cannot
    # hide whether the kernel and libc reached userspace correctly.
    vm-test = callPackage ./vm-test/package.nix { };

    # Shared immutable filesystem construction. Product-specific images remain
    # owned by their consumer packages.
    image = callPackage ./image { };

    # The static site: a page that boots a wasm Linux kernel against the site's
    # own userspace image. The repository is built unsigned and published to R2
    # by scripts/publish-apk-repo.sh, which owns the signing key.
    site-repository = callPackage ./site/repository.nix { };
    site-rootfs = callPackage ./site/rootfs.nix {
      repository = self.site-repository;
    };
    site = callPackage ./site/package.nix {
      rootfs = self.site-rootfs;
    };

    # The deploy wrapper. Building it realizes the site and wrangler; running
    # it materializes the assets into ./deploy (dereferencing the store
    # symlinks) and invokes wrangler with the given subcommand, defaulting to
    # `deploy` for production and `versions upload` for a preview.
    site-deploy = pkgs.writeShellScript "site-deploy" ''
      set -euo pipefail
      root="$(git rev-parse --show-toplevel)"
      cd "$root"
      # A previous run leaves deploy/ read-only (copied from the store).
      chmod -R u+w deploy 2>/dev/null || true
      rm -rf deploy
      cp -rL ${self.site} deploy
      chmod -R u+w deploy
      exec ${pkgs.wrangler}/bin/wrangler "''${1:-deploy}" "''${@:2}"
    '';

    apk-checks = callPackage ./apk/checks.nix { };
    repositories = {
      main = mainRepository // {
        checks.install = self.apk-checks.install;
      };
      recurseForDerivations = true;
    };
    # Conventional flat flake entry point for the primary published artifact.
    repository = mainRepository;

    # The private guest protocol and its JavaScript SDK ship together.
    guest-agent = callPackage ./guest-agent/package.nix { };
    ltp = callPackage ./ltp/package.nix { };
    kselftests = callPackage ./kselftests/package.nix { };
    node-workspace = callPackage ./node-workspace.nix { };
    linux-guest = callPackage ./linux-guest { };
    runner = callPackage ./runner { };
    browser-tests = callPackage ./browser-tests/package.nix { };
  }
)
