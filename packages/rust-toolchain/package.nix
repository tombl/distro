# The Rust toolchain for wasm32-unknown-linux-musl: a pinned nightly rustc
# with a from-source std sysroot for the wasm target, wrapped so consumers see
# a compiler that simply knows the target. Nightly is a hard requirement for
# now: custom target specs sit behind -Zunstable-options and std is built with
# -Zbuild-std. Everything unstable is confined to this file; `buildRustPackage`
# consumers run plain `cargo build --target wasm32-unknown-linux-musl`.
#
# The libc crate needs a real fork (upstream's wasm32+musl support is WALI's
# b64 ABI with syscalls as host imports; ours is ILP32 through musl), pinned as
# the libc-src input. The std patches are small enough to live in patches/.
{
  lib,
  pkgs,
  platform,
  stdenv,
  llvm-toolchain,
  fenix ?
    import
      (pkgs.fetchFromGitHub {
        owner = "nix-community";
        repo = "fenix";
        rev = "fa09e6473a0dfd673e6cb9a37741aec513b4bb2a";
        hash = "sha256-qsmQMPL+qInjXfdjX0RquObSKcs5h/4D63IWH9j4+Ro=";
      })
      {
        inherit pkgs;
        inherit (pkgs) system;
      },
  libc-src ? pkgs.fetchFromGitHub {
    owner = "tombl";
    repo = "libc";
    rev = "fc8cc62b93f1c374e944d7880e71aa16434b7c6e";
    hash = "sha256-s2qZCiyVgLGZh6x5E4pmVT3mnoEF8q4M3bWdXVqGclQ=";
  },
}:

let
  inherit (platform) targetTriple;

  toolchain = fenix.complete.withComponents [
    "rustc"
    "cargo"
    "rust-src"
    "rust-std"
  ];

  # -m<feature> compiler flags and LLVM target features are the same set spelled
  # differently; mutable-globals and sign-ext are clang defaults the sysroot is
  # compiled with, so rustc must match.
  features = map (f: "+" + lib.removePrefix "-m" f) platform.compilerFlags ++ [
    "+mutable-globals"
    "+sign-ext"
  ];

  # The spec mirrors wasm32-wali-linux-musl where our platforms agree (both are
  # musl on a wasm32 Linux kernel) and diverges where the ABIs do: ILP32, musl
  # crt1 entry, static-only linking through the wrapped clang driver.
  targetSpec = {
    arch = "wasm32";
    os = "linux";
    env = "musl";
    vendor = "unknown";
    llvm-target = targetTriple;
    data-layout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20";
    target-pointer-width = 32;
    max-atomic-width = 64;
    target-family = [
      "wasm"
      "unix"
    ];
    features = lib.concatStringsSep "," features;

    # musl's crt1 _start fetches argv from the kernel and calls the weak
    # __main_void, whose libc definition forwards real argc/argv to
    # __main_argc_argv. Emitting that symbol gives std::env::args the real
    # arguments with no wasm-specific code in std.
    entry-name = "__main_argc_argv";
    main-needs-argc-argv = true;

    linker = "${stdenv.cc}/bin/${stdenv.cc.targetPrefix}clang";
    linker-flavor = "wasm-lld-cc";
    linker-is-gnu = false;
    lld-flavor = "wasm";
    pre-link-args."wasm-lld-cc" = map (flag: "-Wl,${flag}") platform.linkerFlags ++ [
      "-Wl,--no-demangle"
    ];

    crt-static-default = true;
    crt-static-respected = true;
    crt-objects-fallback = "false";
    dynamic-linking = false;
    relocation-model = "static";
    panic-strategy = "abort";
    singlethread = false;
    has-thread-local = true;
    tls-model = "local-exec";
    is-like-wasm = true;
    eh-frame-header = false;
    emit-debug-gdb-scripts = false;
    generate-arange-section = false;
    limit-rdylib-exports = false;
  };

  # rustc resolves `--target ${targetTriple}` to ${targetTriple}.json via
  # RUST_TARGET_PATH, so cargo only ever sees an ordinary target name.
  targetSpecDir = pkgs.writeTextDir "${targetTriple}.json" (builtins.toJSON targetSpec);

  patches = [
    ./patches/0001-core-gate-wali-c_long-on-vendor.patch
    ./patches/0002-std-args-gate-wali-on-vendor.patch
    ./patches/0003-std-no-stack-overflow-handler-on-wasm32.patch
  ];

  # Registry dependencies of the std workspace, resolved by ./Cargo.lock. The
  # lock is the toolchain's own library/Cargo.lock with libc re-locked to the
  # fork; regenerate it when bumping fenix or libc-src:
  #   cp -rL $(nix build --print-out-paths .#rust-toolchain.toolchain)/lib/rustlib/src/rust/library lib
  #   chmod -R u+w lib && cd lib
  #   sed -i "s|^\[patch.crates-io\]$|[patch.crates-io]\nlibc = { path = '$PWD/../checkouts/libc' }|" Cargo.toml
  #   cargo update -p libc && cp Cargo.lock ../packages/rust-toolchain/Cargo.lock
  vendoredDeps = pkgs.rustPlatform.importCargoLock { lockFile = ./Cargo.lock; };

  mkRustcWrapper =
    { name, sysroot }:
    pkgs.writeShellScriptBin name ''
      export RUST_TARGET_PATH="${targetSpecDir}''${RUST_TARGET_PATH:+:$RUST_TARGET_PATH}"
      exec ${toolchain}/bin/rustc ${
        lib.optionalString (sysroot != null) "--sysroot ${sysroot}"
      } -Zunstable-options "$@"
    '';

  stdSysroot =
    pkgs.runCommand "rust-std-${targetTriple}"
      {
        nativeBuildInputs = [
          toolchain
          # Host cc: the workspace's build scripts compile and link for the
          # build platform. llvm-toolchain stays off PATH; its unprefixed cc
          # has no host sysroot and would shadow this one.
          pkgs.stdenv.cc
        ];
      }
      ''
        cp -rL ${toolchain}/lib/rustlib/src/rust src
        chmod -R u+w src
        ${lib.concatMapStrings (patch: ''
          patch -p1 -d src < ${patch}
        '') patches}

        sed -i "s|^\[patch.crates-io\]$|[patch.crates-io]\nlibc = { path = \"${libc-src}\" }|" \
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
        build-std = ["std", "panic_abort"]
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

  cargo = fenix.complete.cargo;

  # The wasm stdenv exports executable-shaping linker flags globally. Cargo's
  # build scripts are host binaries, so keep those flags away from their host
  # links while retaining them for the target linker.
  hostLinker = pkgs.writeShellScript "rust-host-linker" ''
    unset NIX_CFLAGS_LINK NIX_LDFLAGS
    exec ${pkgs.stdenv.cc}/bin/cc "$@"
  '';

  buildRustPackage = lib.makeOverridable (
    {
      cargoLock ? null,
      cargoPathOverrides ? [ ],
      ...
    }@args:
    stdenv.mkDerivation (
      removeAttrs args [
        "cargoLock"
        "cargoPathOverrides"
      ]
      // {
        nativeBuildInputs = [
          rustc
          cargo
        ]
        ++ (args.nativeBuildInputs or [ ]);

        buildPhase =
          args.buildPhase or ''
            runHook preBuild

            export CARGO_HOME=$TMPDIR/cargo-home
            mkdir -p $CARGO_HOME
            # Cargo's path override keeps the target's libc fork local to this
            # Rust platform instead of requiring every consumer manifest to
            # repeat a [patch.crates-io] entry. Path overrides deliberately
            # require the fork's name and version to match Cargo.lock.
            cat > $CARGO_HOME/config.toml <<EOF
            paths = ${builtins.toJSON (map (path: "${path}") ([ libc-src ] ++ cargoPathOverrides))}

            [target.${pkgs.stdenv.hostPlatform.rust.rustcTarget}]
            linker = "${hostLinker}"

            EOF
            export CC_${pkgs.stdenv.hostPlatform.rust.cargoEnvVarTarget}=${pkgs.stdenv.cc}/bin/cc
            export CXX_${pkgs.stdenv.hostPlatform.rust.cargoEnvVarTarget}=${pkgs.stdenv.cc}/bin/c++
            ${lib.optionalString (cargoLock != null) ''
              cat >> $CARGO_HOME/config.toml <<EOF
              [source.crates-io]
              replace-with = "vendored-sources"
              [source.vendored-sources]
              directory = "${pkgs.rustPlatform.importCargoLock cargoLock}"
              EOF
            ''}
            export CARGO_BUILD_JOBS=$NIX_BUILD_CORES
            cargo build --release --offline --target ${targetTriple}

            runHook postBuild
          '';

        installPhase =
          args.installPhase or ''
            runHook preInstall

            find target/${targetTriple}/release -maxdepth 1 -type f -executable \
              -exec install -Dm755 -t $out/bin {} +

            runHook postInstall
          '';
      }
    )
  );
in
{
  inherit
    toolchain
    targetSpecDir
    sysroot
    rustc
    cargo
    buildRustPackage
    ;
  # `nix build .#rust-toolchain` builds the substantial artifact.
  package = stdSysroot;
}
