# The nixpkgs-compatible Rust platform for wasm32 Linux. Consumers use the
# ordinary buildRustPackage interface; the Cargo wrapper supplies the target
# and the complete exact-version crates.io overlay implicitly.
{
  lib,
  pkgs,
  platform,
  stdenv,
  rust-toolchain,
  rust-crate-patches,
}:

let
  inherit (platform) targetTriple;

  patchConfig = lib.concatMapStringsSep "\n" (
    {
      alias,
      package,
      path,
    }:
    ''${alias} = { package = "${package}", path = "${path}" }''
  ) rust-crate-patches.entries;

  commonCargoConfig = ''
    [patch.crates-io]
    ${patchConfig}

    # Target crt objects are ordinary wasm objects rather than LLVM bitcode.
    [profile.release]
    lto = false
  '';

  nixCargoConfig = pkgs.writeText "wasm32-linux-nix-cargo-config.toml" commonCargoConfig;

  cargoConfig = pkgs.writeText "wasm32-linux-cargo-config.toml" ''
    [build]
    target = "${targetTriple}"

    ${commonCargoConfig}

    [target.${targetTriple}]
    linker = "${stdenv.cc}/bin/${stdenv.cc.targetPrefix}cc"
    rustflags = [
      "--cfg", "rustix_use_libc",
      "--remap-path-prefix=/nix/store=/usr/src/nix",
    ]
  '';

  cargoConfigHook = pkgs.makeSetupHook {
    name = "lowland-cargo-config-hook";
    substitutions = { inherit nixCargoConfig; };
  } ./cargo-config-hook.sh;

  cargo =
    (pkgs.writeShellScriptBin "cargo" ''
      # Keep the frontend and compiler paired when consumers install only this
      # wrapper from Nix; an explicit RUSTC remains an escape hatch.
      export RUSTC="''${RUSTC:-${rust-toolchain.rustc}/bin/rustc}"
      exec ${rust-toolchain.cargo}/bin/cargo --config ${cargoConfig} "$@"
    '').overrideAttrs
      (old: {
        passthru = (old.passthru or { }) // {
          inherit cargoConfig;
          unwrapped = rust-toolchain.cargo;
        };
      });

  base = pkgs.makeRustPlatform {
    inherit stdenv;
    inherit (rust-toolchain) cargo rustc;
  };

  # makeRustPlatform is splice-aware. This platform lives in a repository
  # scope rather than a nixpkgs package set, so pin the three cross tools again
  # at the final builder boundary instead of allowing the host splice to
  # replace them with nixpkgs' native Rust toolchain.
  baseBuildRustPackage = base.buildRustPackage.override {
    inherit stdenv;
    inherit (rust-toolchain) cargo rustc;
  };

  asList = value: if builtins.isList value then value else lib.optional (value != "") value;

  # Cross-target tests cannot run on the builder. Compile them by default so
  # ordinary doCheck behavior still catches missing APIs and cfg mistakes.
  buildRustPackage = lib.makeOverridable (
    args:
    (baseBuildRustPackage (
      args
      // {
        nativeBuildInputs = [ cargoConfigHook ] ++ (args.nativeBuildInputs or [ ]);
        RUSTFLAGS = asList (args.RUSTFLAGS or [ ]) ++ [
          "-Ctarget-feature=+crt-static"
          "-Cforce-frame-pointers=yes"
          "--cfg"
          "rustix_use_libc"
          "--remap-path-prefix=/nix/store=/usr/src/nix"
        ];
        cargoTestFlags = [ "--no-run" ] ++ (args.cargoTestFlags or [ ]);
        # Cross stdenv suppresses checkPhase because it assumes tests must be
        # executed. Invoke nixpkgs' own Cargo check hook after the build so its
        # normal feature/test flags still apply, with --no-run supplied above.
        postBuild =
          (args.postBuild or "")
          + lib.optionalString (args.doCheck or true) ''
            cargoCheckHook
          '';
        # cc-rs' wasm32 Linux support asks for this explicitly when a crate
        # builds bundled C code. The cross compiler already embeds the same
        # sysroot, but exporting it lets build scripts validate that contract.
        WASM_MUSL_SYSROOT = args.WASM_MUSL_SYSROOT or "${stdenv.cc.libc}";
      }
    )).overrideAttrs
      (old: {
        # nixpkgs derives this list from its upstream rustc catalog, which
        # cannot name this repository's custom target even though the actual
        # rustc input above carries and compiles it.
        meta = (old.meta or { }) // {
          platforms = (args.meta or { }).platforms or [ stdenv.hostPlatform.system ];
        };
      })
  );
in
base
// {
  inherit
    buildRustPackage
    cargo
    cargoConfig
    cargoConfigHook
    ;
  inherit (rust-toolchain) rustc;
}
