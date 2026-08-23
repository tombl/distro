# Exact-version compatibility sources shared by the Rust CLI matrix. rustix
# remains on its libc backend; linux-raw-sys supplies UAPI types and numbers,
# never a WebAssembly raw-syscall implementation.
{
  lib,
  pkgs,
  linux,
  llvm-toolchain-unwrapped,
}:

let
  fetchCrateSource = import ../rust-crate-source.nix { inherit pkgs; };

  generatorSource = pkgs.fetchFromGitHub {
    owner = "sunfishcode";
    repo = "linux-raw-sys";
    rev = "0e2918cf3e366d9c923d4ca05f169b49d826db56";
    hash = "sha256-2wS3j8019y7RJMbTmKsxu6alzHfX6yAtsYZy3YkSiFk=";
  };

  linuxRawSysUpstream = {
    "0.11.0" = fetchCrateSource {
      name = "linux-raw-sys";
      version = "0.11.0";
      hash = "sha256-3x08O1PaZM9XYEgic6mOV1xlGmfux/d9+WtbZC3o8Dk=";
    };
    "0.12.1" = fetchCrateSource {
      name = "linux-raw-sys";
      version = "0.12.1";
      hash = "sha256-MqZpSeAw2gDox9RDSyUWcKkVVvQUSUHTdFJ2nCXVilM=";
    };
  };

  rustixUpstream = {
    "1.1.2" = fetchCrateSource {
      name = "rustix";
      version = "1.1.2";
      hash = "sha256-zRX4osVVGoTVbv3BzQSQieQJrBmjBy1QN6F/1wcZ/z4=";
    };
    "1.1.3" = fetchCrateSource {
      name = "rustix";
      version = "1.1.3";
      hash = "sha256-FGyeJHzMGAwfYWFUM4aMmfPeOuJWowpDtJ9nwtkXHzQ=";
    };
    "1.1.4" = fetchCrateSource {
      name = "rustix";
      version = "1.1.4";
      hash = "sha256-tv5FZblRi4PvT5G7R84pYgyoKL0yy35AjwBi6ZMLoZA=";
    };
  };

  mioUpstream = {
    "1.1.1" = fetchCrateSource {
      name = "mio";
      version = "1.1.1";
      hash = "sha256-ppvKsK1HJxoCNNlCKxMYBr85aAIeXckyjK8tTNWFV/w=";
    };
    "1.2.0" = fetchCrateSource {
      name = "mio";
      version = "1.2.0";
      hash = "sha256-ULflsnqgKnS6yMPyP0SPjYf/EfktOqwabtNp7gjMVsE=";
    };
  };

  generator = pkgs.rustPlatform.buildRustPackage {
    pname = "linux-raw-sys-wasm-generator";
    version = "0.12.1";
    src = generatorSource;
    patches = [ ./linux-raw-sys-generator.patch ];
    cargoRoot = "gen";
    buildAndTestSubdir = "gen";
    cargoLock.lockFile = ./generator-Cargo.lock;
    postPatch = "cp ${./generator-Cargo.lock} gen/Cargo.lock";
    nativeBuildInputs = [ llvm-toolchain-unwrapped ];
    LIBCLANG_PATH = "${llvm-toolchain-unwrapped}/lib";
  };

  mkLinuxRawSys =
    version:
    pkgs.runCommand "linux-raw-sys-${version}-wasm32-linux"
      {
        nativeBuildInputs = [
          generator
          # Linux headers_install builds host helpers; use the build-platform
          # clang with its host sysroot. Bindgen itself is linked to the
          # patched libclang through the generator derivation above.
          pkgs.clang
          pkgs.gnumake
          pkgs.patch
          pkgs.rsync
          pkgs.rustfmt
        ];
      }
      ''
        cp -r ${generatorSource} generator-source
        chmod -R u+w generator-source
        cp -r ${linux.src} generator-source/gen/linux
        chmod -R u+w generator-source/gen/linux
        (cd generator-source/gen && ${generator}/bin/gen)

        general=generator-source/src/wasm32/general.rs
        grep -Fqx 'pub const __NR_clone: u32 = 220;' "$general"
        grep -Fqx 'pub const __NR_futex_time64: u32 = 422;' "$general"
        grep -Fqx 'pub const __NR_set_thread_area: u32 = 244;' "$general"
        grep -Fqx 'pub const __NR_wasm_get_args: u32 = 245;' "$general"
        if grep -Eq '^pub const __NR_(mmap|munmap|brk):' "$general"; then
          echo "wasm32 Linux UAPI unexpectedly exposes an unsupported memory syscall" >&2
          exit 1
        fi

        cp -r ${linuxRawSysUpstream.${version}} $out
        chmod -R u+w $out
        patch -p1 -d $out < ${./linux-raw-sys-lib.patch}
        mkdir $out/src/wasm32
        cp generator-source/src/wasm32/*.rs $out/src/wasm32/
        cp ${./wasm32-ioctl.rs} $out/src/wasm32/ioctl.rs

        # The generator patch is the single source of truth for the supported
        # module set. Publish every binding it emitted for the Lowland target.
        for module_path in generator-source/src/wasm32/*.rs; do
          test -s "$module_path"
          module=''${module_path##*/}
          module=''${module%.rs}
          printf '%s\n' \
            "#[cfg(feature = \"$module\")]" \
            '#[cfg(all(' \
            '    target_arch = "wasm32",' \
            '    target_os = "linux",' \
            '    target_env = "musl",' \
            '    target_vendor = "unknown",' \
            '))]' \
            "#[path = \"wasm32/$module.rs\"]" \
            "pub mod $module;" \
            >> $out/src/lib.rs
        done
      '';

  linuxRawSys = lib.mapAttrs (version: _: mkLinuxRawSys version) linuxRawSysUpstream;

  mkRustix =
    version:
    pkgs.runCommand "rustix-${version}-wasm32-linux"
      {
        nativeBuildInputs = [ pkgs.patch ];
      }
      ''
        cp -r ${rustixUpstream.${version}} $out
        chmod -R u+w $out
        patch -p1 -d $out < ${./rustix-wasm32-linux.patch}
      '';

  rustix = lib.mapAttrs (version: _: mkRustix version) rustixUpstream;

  mkMio =
    version:
    pkgs.runCommand "mio-${version}-wasm32-linux"
      {
        nativeBuildInputs = [ pkgs.patch ];
      }
      ''
        cp -r ${mioUpstream.${version}} $out
        chmod -R u+w $out
        patch -p1 -d $out < ${./mio-wasm32-linux.patch}
      '';

  mio = lib.mapAttrs (version: _: mkMio version) mioUpstream;
in
{
  inherit
    generator
    linuxRawSys
    mio
    rustix
    ;

  entries = [
    {
      alias = "linux_raw_sys_0_11";
      package = "linux-raw-sys";
      path = linuxRawSys."0.11.0";
    }
    {
      alias = "linux_raw_sys_0_12";
      package = "linux-raw-sys";
      path = linuxRawSys."0.12.1";
    }
    {
      alias = "rustix_1_1_2";
      package = "rustix";
      path = rustix."1.1.2";
    }
    {
      alias = "rustix_1_1_3";
      package = "rustix";
      path = rustix."1.1.3";
    }
    {
      alias = "rustix_1_1_4";
      package = "rustix";
      path = rustix."1.1.4";
    }
    {
      alias = "mio_1_1_1";
      package = "mio";
      path = mio."1.1.1";
    }
    {
      alias = "mio_1_2_0";
      package = "mio";
      path = mio."1.2.0";
    }
  ];

  package = linuxRawSys."0.12.1";
  recurseForDerivations = true;
}
