# Exact-version crates which make crates.io dependency graphs treat the target
# as ordinary Linux and Unix. Cargo consumes this catalog globally through its
# configuration; package expressions never select transitive patches.
{
  lib,
  pkgs,
  rust-toolchain,
  rust-compat,
}:

let
  fetchCrateSource = import ../rust-crate-source.nix { inherit pkgs; };

  mkPatchedCrate =
    {
      name,
      version,
      hash,
      patch ? null,
      patches ? [ ],
      normalizeCrLf ? false,
    }:
    let
      upstream = fetchCrateSource { inherit name version hash; };
    in
    pkgs.runCommand "${name}-${version}-wasm32-linux"
      {
        nativeBuildInputs = [ pkgs.patch ];
      }
      ''
        cp -r ${upstream} $out
        chmod -R u+w $out
        ${lib.optionalString normalizeCrLf "sed -i 's/\\r$//' $out/src/lib.rs"}
        ${lib.concatMapStrings (cratePatch: "patch -p1 -d $out < ${cratePatch}\n") (
          patches ++ lib.optional (patch != null) patch
        )}
      '';

  matrixSources = {
    gix_index_0_53 = {
      package = "gix-index";
      path = mkPatchedCrate {
        name = "gix-index";
        version = "0.53.0";
        hash = "sha256-NtRfguxaTXVC6llemtFuA+JsjLTyIeW8n83PRp9jpoE=";
        patch = ./gix-index-file-io-wasm.patch;
      };
    };
    gix_ref_0_65 = {
      package = "gix-ref";
      path = mkPatchedCrate {
        name = "gix-ref";
        version = "0.65.0";
        hash = "sha256-m7+84d/X1/hGnd7201GDdq/2ZDSPFTy+D8PljvmT0k4=";
        patch = ./gix-ref-file-io-wasm.patch;
      };
    };
    gix_odb_0_82 = {
      package = "gix-odb";
      path = mkPatchedCrate {
        name = "gix-odb";
        version = "0.82.0";
        hash = "sha256-f63Fn2+g+d1EXs7uYQYKK1nKVX9I2p/Gd/Vn21NbeCo=";
        patch = ./gix-odb-file-io-wasm.patch;
      };
    };
    gix_pack_0_72 = {
      package = "gix-pack";
      path = mkPatchedCrate {
        name = "gix-pack";
        version = "0.72.0";
        hash = "sha256-yj5/FybNLAzRzx/CC+io5iPwsWPx+Nb8g2z7m8jNdYs=";
        patch = ./gix-pack-file-io-wasm.patch;
      };
    };
    gix_commitgraph_0_37 = {
      package = "gix-commitgraph";
      path = mkPatchedCrate {
        name = "gix-commitgraph";
        version = "0.37.1";
        hash = "sha256-f2ddDfSEp/akfmS9bzEa9InZR8AyOwVk820U89d2Krs=";
        patch = ./gix-commitgraph-file-io-wasm.patch;
      };
    };
    filetime_0_2_29 = {
      package = "filetime";
      path = mkPatchedCrate {
        name = "filetime";
        version = "0.2.29";
        hash = "sha256-XCh6M8fwpiDDjmQef2CCdxOYezwPJujdyUYsxpz3V1k=";
        patch = ./filetime-wasm32-linux-unix.patch;
      };
    };
    sysinfo_0_33 = {
      package = "sysinfo";
      path = mkPatchedCrate {
        name = "sysinfo";
        version = "0.33.1";
        hash = "sha256-T8hYJI6gG2bxnY6KbVX0Her5Hp1JUkb9ATaNmZNcbAE=";
        patch = ./sysinfo-wasm32-linux-libc.patch;
      };
    };
    sysinfo_0_29 = {
      package = "sysinfo";
      path = mkPatchedCrate {
        name = "sysinfo";
        version = "0.29.11";
        hash = "sha256-zXJ/xCPCBg9sktlTTO92XGWm7T9CigPX3vdKjENI5mY=";
        patch = ./sysinfo-old-wasm32-linux-libc.patch;
      };
    };
    sysinfo_0_37 = {
      package = "sysinfo";
      path = mkPatchedCrate {
        name = "sysinfo";
        version = "0.37.2";
        hash = "sha256-FmB9XK/9HAfOBzUo+e2XLYjbFd1EAj+lcUKWO+P+sR8=";
        patch = ./sysinfo-new-wasm32-linux-libc.patch;
      };
    };
    sysinfo_0_39 = {
      package = "sysinfo";
      path = mkPatchedCrate {
        name = "sysinfo";
        version = "0.39.6";
        hash = "sha256-0gcd+USJFbccT+bSXerxwi8SvSNPAVQLdzEruOQTYeY=";
        patch = ./sysinfo-new-wasm32-linux-libc.patch;
      };
    };
    console_0_15_7 = {
      package = "console";
      path = mkPatchedCrate {
        name = "console";
        version = "0.15.7";
        hash = "sha256-ySbgDMcO3v3GTTpf8xzGW7l6NGAJd2K9I6+02BRfzPg=";
        patch = ./console-wasm32-linux-unix.patch;
      };
    };
    console_0_15_11 = {
      package = "console";
      path = mkPatchedCrate {
        name = "console";
        version = "0.15.11";
        hash = "sha256-BUzLWxD58sv1HrNVyh0FwtJ5zhgEaI0Nt0tHM6Wur9g=";
        patch = ./console-new-wasm32-linux-unix.patch;
      };
    };
    rand_os_0_1 = {
      package = "rand_os";
      path = mkPatchedCrate {
        name = "rand_os";
        version = "0.1.3";
        hash = "sha256-e3X2dqHgU/xWLq+7R4ONZ8hIAeOPwbpFno8YDeq9UHE=";
        patch = ./rand-os-wasm32-linux.patch;
      };
    };
    instant_0_1 = {
      package = "instant";
      path = mkPatchedCrate {
        name = "instant";
        version = "0.1.13";
        hash = "sha256-4CQoGdFTy6S0sFpajyp+m7+XtgVbKgArOVyWtf88AiI=";
        patch = ./instant-wasm32-linux-native.patch;
        normalizeCrLf = true;
      };
    };
    libgit2_sys_0_18 = {
      package = "libgit2-sys";
      path = mkPatchedCrate {
        name = "libgit2-sys";
        version = "0.18.5+1.9.4";
        hash = "sha256-AF1q5urBkSkGBz4Gn322Cx+pjgUqaCJ4JK/j46HFnKI=";
        patch = ./libgit2-sys-wasm32-linux.patch;
      };
    };
    libgit2_sys_0_18_0 = {
      package = "libgit2-sys";
      path = mkPatchedCrate {
        name = "libgit2-sys";
        version = "0.18.0+1.9.0";
        hash = "sha256-4aEXRl5+FZfo/r6ouwxBDxx/uTseHN3zQ2P4OQNn/+w=";
        patch = ./libgit2-sys-wasm32-linux.patch;
      };
    };
    libz_sys_1_1_12 = {
      package = "libz-sys";
      path = mkPatchedCrate {
        name = "libz-sys";
        version = "1.1.12";
        hash = "sha256-2XE3sl4yGnPu8UGNHV0u2k134SgT+OberYS8UsWHCns=";
        patch = ./libz-sys-wasm32-linux-libc.patch;
      };
    };
    libz_sys_1_1_23 = {
      package = "libz-sys";
      path = mkPatchedCrate {
        name = "libz-sys";
        version = "1.1.23";
        hash = "sha256-FdEYu/N3EGDnMRzHuwVFsB0IqLSn3pSRmN7B+gyhwPc=";
        patch = ./libz-sys-wasm32-linux-libc.patch;
      };
    };
    chrono_0_4_31 = {
      package = "chrono";
      path = mkPatchedCrate {
        name = "chrono";
        version = "0.4.31";
        hash = "sha256-fyxoW60+s9RaATVM7bfV+qZhlNHVi6biZ6jeeI952zg=";
        patch = ./chrono-wasm32-linux-unix.patch;
      };
    };
    page_size_0_6 = {
      package = "page_size";
      path = mkPatchedCrate {
        name = "page_size";
        version = "0.6.0";
        hash = "sha256-MNWyGU7RMZHBmZrgcEt4OfsYOE+iLkm1fuqpfXnOQNo=";
        patch = ./page-size-wasm32-linux-unix.patch;
      };
    };
    criterion_0_8 = {
      package = "criterion";
      path = mkPatchedCrate {
        name = "criterion";
        version = "0.8.2";
        hash = "sha256-lQBGsqokkvmlNvX0+aPee54kduV14FvWwzM3Gt1NmPM=";
        patch = ./criterion-wasm32-linux-threads.patch;
      };
    };
    dirs_6 = {
      package = "dirs";
      path = mkPatchedCrate {
        name = "dirs";
        version = "6.0.0";
        hash = "sha256-w+iqlNdRQSKEgClafQ5/62ILGlrZ8SvEC+YkEeOMzk4=";
        patch = ./dirs-wasm32-linux-native.patch;
      };
    };
  };

  libcSources = lib.mapAttrs' (
    version: path:
    lib.nameValuePair "libc_${lib.replaceStrings [ "." ] [ "_" ] version}" {
      package = "libc";
      inherit path;
    }
  ) rust-toolchain.libcSrcs;

  baseSources = lib.listToAttrs (
    map (entry: {
      name = entry.alias;
      value = {
        inherit (entry) package path;
      };
    }) rust-compat.entries
  );

  sources = libcSources // baseSources // matrixSources;
in
{
  inherit sources;

  entries = lib.mapAttrsToList (
    alias:
    {
      package,
      path,
    }:
    {
      inherit alias package path;
    }
  ) sources;

  package = pkgs.linkFarm "rust-crate-patches" (
    lib.mapAttrsToList (name: path: { inherit name path; }) (
      lib.mapAttrs (_: entry: entry.path) sources
    )
  );
  recurseForDerivations = true;
}
