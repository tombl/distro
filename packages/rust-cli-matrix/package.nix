# The ten locked CLI graphs used as the compatibility acceptance matrix. Each
# source and Cargo.lock is immutable, while exact compatibility patches are
# supplied through Cargo's version-matching path override mechanism.
{
  lib,
  pkgs,
  rust-toolchain,
  rust-compat,
  busybox,
  git,
  vm-test,
}:

let
  fetch =
    {
      owner,
      repo,
      rev,
      hash,
    }:
    pkgs.fetchFromGitHub {
      inherit
        owner
        repo
        rev
        hash
        ;
    };

  fetchCrateSource =
    {
      name,
      version,
      hash,
    }:
    let
      archive = pkgs.fetchurl {
        url = "https://static.crates.io/crates/${name}/${name}-${version}.crate";
        inherit hash;
      };
    in
    pkgs.runCommand "${name}-${version}-source"
      {
        nativeBuildInputs = [
          pkgs.gnutar
          pkgs.gzip
        ];
      }
      ''
        mkdir $out
        tar -xzf ${archive} --strip-components=1 -C $out
      '';

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

  compatibilitySources = {
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

  matrixCargoPatchOverrides = lib.mapAttrsToList (
    alias:
    {
      package,
      path,
    }:
    {
      inherit alias package path;
    }
  ) compatibilitySources;

  cargoPatchOverrides = rust-compat.cargoPatchOverrides ++ matrixCargoPatchOverrides;

  specs = {
    ripgrep = {
      version = "15.2.0";
      src = fetch {
        owner = "BurntSushi";
        repo = "ripgrep";
        rev = "435f59fc4b43af3ab32f34d53fa34978f393fe52";
        hash = "sha256-tEE7D6kKw6/CdzfFgm1l/YS4f2lYZCN0IQLNEI+z5q4=";
      };
      patches = [ ./ripgrep-no-mmap-wasm.patch ];
      compatPatches = [ ];
    };
    fd = {
      version = "10.4.2";
      src = fetch {
        owner = "sharkdp";
        repo = "fd";
        rev = "41532d114e2ba565fb5367d606c111b29b96450c";
        hash = "sha256-8aI86ZpDR05cBitGQ6FvCuYjaVBFlSjFApalynwY1bg=";
      };
      compatPatches = [
        "linux_raw_sys_0_12"
        "rustix_1_1_4"
      ];
    };
    bat = {
      version = "0.26.1";
      src = fetch {
        owner = "sharkdp";
        repo = "bat";
        rev = "73dc3258bec83bd7c66334f05b13c2d8221859f9";
        hash = "sha256-i48IFCdUI5fcyR+TOO17IcLtKl6VvwBk4f/2EYfJQvQ=";
      };
      compatPatches = [
        "linux_raw_sys_0_12"
        "rustix_1_1_4"
        "mio_1_2_0"
        "gix_index_0_53"
        "gix_ref_0_65"
        "gix_odb_0_82"
        "gix_pack_0_72"
        "gix_commitgraph_0_37"
        "filetime_0_2_29"
        "sysinfo_0_33"
      ];
    };
    uutils = {
      version = "0.9.0";
      src = fetch {
        owner = "uutils";
        repo = "coreutils";
        rev = "eae5c43a175ff8195997eac7945bac7e2690a2be";
        hash = "sha256-eOnh7btgZkI/ymtyQuwGtLxiDhbHAIUIBJbLc/Xs+Us=";
      };
      patches = [
        ./uutils-tac-no-mmap-wasm.patch
        ./uutils-timespec-padding.patch
      ];
      compatPatches = [
        "linux_raw_sys_0_12"
        "rustix_1_1_4"
        "mio_1_1_1"
      ];
    };
    eza = {
      version = "0.23.5";
      src = fetch {
        owner = "eza-community";
        repo = "eza";
        rev = "98442ab17c2c3738701b62a7e060b1431ae2d6ea";
        hash = "sha256-4XgPePl90mnQxmTUJfOvIsCcTRSYNBuRUNOb/3kmO1k=";
      };
      compatPatches = [
        "linux_raw_sys_0_11"
        "rustix_1_1_3"
        "libgit2_sys_0_18"
        "libz_sys_1_1_23"
        "page_size_0_6"
        "criterion_0_8"
      ];
    };
    zoxide = {
      version = "0.10.0";
      src = fetch {
        owner = "ajeetdsouza";
        repo = "zoxide";
        rev = "cf086b057dfcc7c306450c70829b2788a3e64219";
        hash = "sha256-6MsfxcPcFbsXGSCYerkGM83dVayeh2xw0XAKGoa8ODs=";
      };
      compatPatches = [
        "linux_raw_sys_0_12"
        "rustix_1_1_4"
      ];
    };
    bottom = {
      version = "0.14.7";
      src = fetch {
        owner = "ClementTsang";
        repo = "bottom";
        rev = "6f3b62851eba9c27da4dcfc9f4edc8b9531f2d30";
        hash = "sha256-EXbj/T3wt4gph1FZ71iK0rdRZMewY3EHpOMWsCFUnc0=";
      };
      compatPatches = [
        "linux_raw_sys_0_12"
        "rustix_1_1_4"
        "mio_1_1_1"
        "sysinfo_0_39"
      ];
    };
    hyperfine = {
      version = "1.20.0";
      src = fetch {
        owner = "sharkdp";
        repo = "hyperfine";
        rev = "f12f3d9f86f3643b3b7deace5e160b1f0f44d2b7";
        hash = "sha256-EDef3w97nUQzfHyMFVRkQur1WMD6TvAG20ES86FeWlw=";
      };
      compatPatches = [
        "linux_raw_sys_0_11"
        "rustix_1_1_2"
        "console_0_15_11"
        "rand_os_0_1"
        "instant_0_1"
      ];
    };
    delta = {
      version = "0.19.2";
      src = fetch {
        owner = "dandavison";
        repo = "delta";
        rev = "3b70fd01f67c5df1952daf581af0c585042a48c2";
        hash = "sha256-XJhY3Sb9orIN20je7e3DjPKHrl37Gf6+31YhgvwAOQM=";
      };
      compatPatches = [
        "linux_raw_sys_0_12"
        "rustix_1_1_4"
        "console_0_15_7"
        "sysinfo_0_29"
        "libgit2_sys_0_18_0"
        "libz_sys_1_1_12"
        "chrono_0_4_31"
        "dirs_6"
      ];
    };
    dust = {
      version = "1.2.4";
      src = fetch {
        owner = "bootandy";
        repo = "dust";
        rev = "93fe658574b1677052fba8b042283174b0fdef49";
        hash = "sha256-rxlrmlfnCN9HM85jvQCfld16s+tpKx8m4A3NDyw6YFc=";
      };
      compatPatches = [
        "linux_raw_sys_0_11"
        "rustix_1_1_3"
        "sysinfo_0_37"
      ];
    };
  };

  mkCandidate =
    name: spec:
    rust-toolchain.buildRustPackage {
      pname = name;
      inherit (spec) version src;
      patches = spec.patches or [ ];
      cargoLock.lockFile = "${spec.src}/Cargo.lock";
      cargoPatchOverrides = builtins.filter (
        patch: builtins.elem patch.alias spec.compatPatches
      ) cargoPatchOverrides;
      doCheck = true;
    };

  candidates = lib.mapAttrs mkCandidate specs;

  mkProbe =
    name: src: compatPatches:
    rust-toolchain.buildRustPackage {
      pname = name;
      version = "0.1.0";
      inherit src;
      cargoLock.lockFile = "${src}/Cargo.lock";
      cargoPatchOverrides = builtins.filter (
        patch: builtins.elem patch.alias compatPatches
      ) cargoPatchOverrides;
      doCheck = true;
    };

  probes = {
    gix-file-probe = mkProbe "gix-file-probe" ./gix-file-probe [
      "linux_raw_sys_0_12"
      "rustix_1_1_4"
      "gix_ref_0_65"
      "gix_commitgraph_0_37"
    ];
  };

  guestCheck = vm-test.vmTest {
    name = "rust-cli-matrix";
    cpus = 2;
    initramfs = vm-test.mkInitramfs {
      name = "rust-cli-matrix";
      init = ./guest-test.sh;
      contents = [
        busybox
        git
      ]
      ++ lib.attrValues candidates
      ++ lib.attrValues probes;
    };
  };
in
{
  inherit candidates probes;
  sources = lib.mapAttrs (_: spec: spec.src) specs;

  package =
    (pkgs.linkFarm "rust-cli-compatibility-matrix" (
      lib.mapAttrsToList (name: path: { inherit name path; }) (candidates // probes)
    )).overrideAttrs
      (_: {
        passthru.checks.guest = guestCheck;
      });
  recurseForDerivations = true;
}
