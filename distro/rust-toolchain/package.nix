# The Rust toolchain for wasm32-unknown-linux-musl: rustc-wasm-linux, which
# knows the target in-tree, with a from-source std sysroot for the wasm target.
# Nightly is a hard requirement for now: std is built with -Zbuild-std.
# Everything unstable is confined to this file; `buildRustPackage` consumers
# run plain `cargo build --target wasm32-unknown-linux-musl`.
#
# libc 0.2.189 is patched locally because upstream's wasm32+musl support is
# WALI's b64 ABI with syscalls as host imports, while ours is ILP32 through
# musl. The std patches are small enough to live in patches/.
{
  lib,
  pkgs,
  platform,
  stdenv,
  llvm-toolchain,
  rustc-wasm-linux,
}:

let
  inherit (platform) targetTriple;

  libcReleases = {
    "0.2.177" = {
      hash = "sha256-KHSir0eiMlwgAabm+tmxalO4AhArUoFjiFFxz5KxWXY=";
      patches = [ ./libc-0.2.177-compat.patch ];
    };
    "0.2.180" = {
      hash = "sha256-vMNaOFRKiRpffIZaylSKmCzLO4ZQpbBtD9M6ECg8Vvw=";
      patches = [ ./libc-0.2.180-compat.patch ];
    };
    "0.2.182" = {
      hash = "sha256-aAC622yyCC/9e2pn5hJbs58YeC95NSDK7oy4hGvgYRI=";
      patches = [ ./libc-0.2.182-compat.patch ];
    };
    "0.2.186" = {
      hash = "sha256-aKuRAX/hbGIkhoQOTIPJo3r+/5eL0jm1KT1h7OWH3mY=";
      patches = [ ./libc-0.2.186-compat.patch ];
    };
    "0.2.189" = {
      hash = "sha256-Pq8+3j/ubbGkwu4JG/iotNzNxtF/ZW+weJbucoZ2EvI=";
      patches = [ ./libc-0.2.189-compat.patch ];
    };
  };

  # Patch every libc release already locked by the acceptance graphs. Cargo
  # can then substitute an exact version without rewriting consumer locks.
  mkLibcSrc =
    version:
    {
      hash,
      patches,
    }:
    let
      archive = pkgs.fetchurl {
        url = "https://static.crates.io/crates/libc/libc-${version}.crate";
        inherit hash;
      };
    in
    pkgs.runCommand "libc-${version}-wasm32-linux"
      {
        nativeBuildInputs = [
          pkgs.gnutar
          pkgs.gzip
          pkgs.patch
        ];
      }
      ''
        mkdir $out
        tar -xzf ${archive} --strip-components=1 -C $out
        chmod -R u+w $out
        ${lib.concatMapStrings (patch: ''
          patch --fuzz=0 --no-backup-if-mismatch -p1 -d $out < ${patch}
        '') patches}
        patch --fuzz=0 --no-backup-if-mismatch -p1 -d $out < ${./libc-wasm32-linux.patch}
      '';

  libcSrcs = lib.mapAttrs mkLibcSrc libcReleases;
  libcSrc = libcSrcs."0.2.189";

  toolchain = rustc-wasm-linux;

  # The standard library sources from the same tarball the compiler was built
  # from; the compiler patches do not touch library/.
  rustSrc = pkgs.runCommand "rust-library-src" { } ''
    mkdir $out
    tar -xJf ${rustc-wasm-linux.src} -C $out --strip-components=1 rustc-nightly-src/library
  '';

  patches = [
    ./patches/0001-core-gate-wali-c_long-on-vendor.patch
    ./patches/0002-std-args-gate-wali-on-vendor.patch
    ./patches/0003-std-no-stack-overflow-handler-on-wasm32.patch
    ./patches/0004-std-fd-dup-on-wasm-linux.patch
    ./patches/0005-std-process-use-posix-spawn-on-wasm-linux.patch
    ./patches/0006-std-tls-destructors-on-wasm-linux.patch
  ];

  # Registry dependencies of the std workspace, resolved by ./Cargo.lock. The
  # lock is the toolchain's own library/Cargo.lock with libc re-locked to the
  # exact locally patched crates.io source; regenerate it when bumping rustc or
  # libc:
  #   cp -rL $(nix build --print-out-paths .#rust-toolchain.rustSrc)/library lib
  #   chmod -R u+w lib && cd lib
  #   sed -i "s|^\[patch.crates-io\]$|[patch.crates-io]\nlibc = { path = '$PWD/../checkouts/libc' }|" Cargo.toml
  #   cargo update -p libc && cp Cargo.lock ../distro/rust-toolchain/Cargo.lock
  vendoredDeps = pkgs.rustPlatform.importCargoLock { lockFile = ./Cargo.lock; };

  mkRustcWrapper =
    { name, sysroot }:
    (pkgs.writeShellScriptBin name ''
      exec ${toolchain}/bin/rustc ${lib.optionalString (sysroot != null) "--sysroot ${sysroot}"} "$@"
    '').overrideAttrs
      (old: {
        passthru = (old.passthru or { }) // {
          badTargetPlatforms = [ ];
          targetPlatforms = [
            pkgs.stdenv.hostPlatform.system
            stdenv.hostPlatform.system
          ];
        };
      });

  stdSysroot =
    pkgs.runCommand "rust-std-${targetTriple}"
      {
        nativeBuildInputs = [
          toolchain
          cargo
          # Host cc: the workspace's build scripts compile and link for the
          # build platform. llvm-toolchain stays off PATH; its unprefixed cc
          # has no host sysroot and would shadow this one.
          pkgs.stdenv.cc
        ];
      }
      ''
        cp -r ${rustSrc} src
        chmod -R u+w src
        ${lib.concatMapStrings (patch: ''
          patch -p1 -d src < ${patch}
        '') patches}

        sed -i "s|^\[patch.crates-io\]$|[patch.crates-io]\nlibc = { path = \"${libcSrc}\" }|" \
          src/library/Cargo.toml
        install -m644 ${./Cargo.lock} src/library/Cargo.lock

        export CARGO_HOME=$PWD/cargo-home
        mkdir -p $CARGO_HOME
        cat > $CARGO_HOME/config.toml <<EOF
        [source.crates-io]
        replace-with = "vendored-sources"
        [source.vendored-sources]
        directory = "${vendoredDeps}"

        # build-std-features = [] drops std's default backtrace machinery,
        # which needs mmap and an unwinder; the platform has neither.
        [unstable]
        build-std = ["std", "panic_abort", "test"]
        build-std-features = []
        EOF

        # std builds as the dependency graph of an empty crate.
        mkdir -p sysroot-build/src
        touch sysroot-build/src/lib.rs
        cat > sysroot-build/Cargo.toml <<EOF
        [package]
        name = "sysroot-build"
        version = "0.0.0"
        edition = "2021"
        EOF

        export RUSTC=${
          mkRustcWrapper {
            name = "rustc-unsysrooted";
            sysroot = null;
          }
        }/bin/rustc-unsysrooted
        # Source locations used by panic reporting survive in the compiled
        # standard library, so remap both immutable inputs and this temporary
        # build tree before every consumer inherits those paths through std.
        export RUSTFLAGS="--remap-path-prefix=/nix/store=/usr/src/nix --remap-path-prefix=$NIX_BUILD_TOP=/usr/src/rust"
        export __CARGO_TESTS_ONLY_SRC_ROOT=$PWD/src/library
        export CARGO_BUILD_JOBS=$NIX_BUILD_CORES
        cd sysroot-build
        cargo build --release --offline --target ${targetTriple}

        lib=$out/lib/rustlib/${targetTriple}/lib
        mkdir -p $lib
        cp target/${targetTriple}/release/deps/*.rlib $lib/

        # panic=abort and wasm cannot unwind, but std's backtrace scaffolding
        # still names _Unwind_ symbols; stub them where -lunwind looks.
        ${stdenv.cc}/bin/${stdenv.cc.targetPrefix}clang -c ${./unwind-stubs.c} -o unwind-stubs.o
        ${llvm-toolchain}/bin/llvm-ar rcs $lib/libunwind.a unwind-stubs.o
      '';

  # One sysroot serves host and wasm compiles: host std comes from the
  # toolchain, the wasm std from stdSysroot.
  sysroot = pkgs.symlinkJoin {
    name = "rust-sysroot-${targetTriple}";
    paths = [
      toolchain
      stdSysroot
    ];
  };

  rustc = mkRustcWrapper {
    name = "rustc";
    inherit sysroot;
  };

  inherit (rustc-wasm-linux) cargo;
in
{
  inherit
    toolchain
    rustSrc
    sysroot
    rustc
    cargo
    ;
  inherit libcSrc libcSrcs;
  # `nix build .#rust-toolchain` builds the substantial artifact.
  package = stdSysroot;
}
