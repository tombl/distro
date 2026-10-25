# Ten ordinary Rust package builds form the compatibility acceptance matrix.
# Target selection and exact transitive crate ports belong to rustPlatform, so
# this file contains only upstream sources and application-level patches.
{
  lib,
  pkgs,
  rustPlatform,
  busybox,
  ca-certificates,
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
      cargoHash = "sha256-2jdWEz7y2T7iJNfRtR8SIPT9CIWfD3NOu+bEH6gSHhY=";
    };
    fd = {
      version = "10.4.2";
      src = fetch {
        owner = "sharkdp";
        repo = "fd";
        rev = "41532d114e2ba565fb5367d606c111b29b96450c";
        hash = "sha256-8aI86ZpDR05cBitGQ6FvCuYjaVBFlSjFApalynwY1bg=";
      };
      cargoHash = "sha256-p+bNUtq5aAeK1gE6U0W08RK0N51odDFY5f/d1swzSVo=";
    };
    bat = {
      version = "0.26.1";
      src = fetch {
        owner = "sharkdp";
        repo = "bat";
        rev = "73dc3258bec83bd7c66334f05b13c2d8221859f9";
        hash = "sha256-i48IFCdUI5fcyR+TOO17IcLtKl6VvwBk4f/2EYfJQvQ=";
      };
      cargoHash = "sha256-Fycw1C6/SmqjBgoGl8YP+520vO1XpegaVa24pp6qVaM=";
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
      cargoHash = "sha256-0Dg8QnnvLTUWE0X8kQ52LMVPImy+Wo3bmGCiyPi6Ve4=";
    };
    eza = {
      version = "0.23.5";
      src = fetch {
        owner = "eza-community";
        repo = "eza";
        rev = "98442ab17c2c3738701b62a7e060b1431ae2d6ea";
        hash = "sha256-4XgPePl90mnQxmTUJfOvIsCcTRSYNBuRUNOb/3kmO1k=";
      };
      cargoHash = "sha256-IRG+mVgU8ZZ8PsxZWqmf3ZjW8fGL0RD0CwIrjsL366I=";
    };
    zoxide = {
      version = "0.10.0";
      src = fetch {
        owner = "ajeetdsouza";
        repo = "zoxide";
        rev = "cf086b057dfcc7c306450c70829b2788a3e64219";
        hash = "sha256-6MsfxcPcFbsXGSCYerkGM83dVayeh2xw0XAKGoa8ODs=";
      };
      cargoHash = "sha256-5Be/eIMn3JurFIhoPK6B5L054lLPek9CR93zTJzJS6w=";
    };
    bottom = {
      version = "0.14.7";
      src = fetch {
        owner = "ClementTsang";
        repo = "bottom";
        rev = "6f3b62851eba9c27da4dcfc9f4edc8b9531f2d30";
        hash = "sha256-EXbj/T3wt4gph1FZ71iK0rdRZMewY3EHpOMWsCFUnc0=";
      };
      cargoHash = "sha256-2Erh+pgZPZEmvFAtWNPqKVkQx3/hznC82M5a36cWfZY=";
    };
    hyperfine = {
      version = "1.20.0";
      src = fetch {
        owner = "sharkdp";
        repo = "hyperfine";
        rev = "f12f3d9f86f3643b3b7deace5e160b1f0f44d2b7";
        hash = "sha256-EDef3w97nUQzfHyMFVRkQur1WMD6TvAG20ES86FeWlw=";
      };
      cargoHash = "sha256-0e6QDVv//WQtfvrJj6jW1sEz7jFv3VC6UKLvclyytLs=";
    };
    delta = {
      version = "0.19.2";
      src = fetch {
        owner = "dandavison";
        repo = "delta";
        rev = "3b70fd01f67c5df1952daf581af0c585042a48c2";
        hash = "sha256-XJhY3Sb9orIN20je7e3DjPKHrl37Gf6+31YhgvwAOQM=";
      };
      cargoHash = "sha256-CC2ncgujdcn1CJxU16beCjfQ1HR2+f6D8qYbZULEm7g=";
    };
    dust = {
      version = "1.2.4";
      src = fetch {
        owner = "bootandy";
        repo = "dust";
        rev = "93fe658574b1677052fba8b042283174b0fdef49";
        hash = "sha256-rxlrmlfnCN9HM85jvQCfld16s+tpKx8m4A3NDyw6YFc=";
      };
      cargoHash = "sha256-dXlyoBYsgnyKvoNh60uR1itDB/fqzIQtZ1R/gv28CMY=";
    };
  };

  mkCandidate =
    name: spec:
    rustPlatform.buildRustPackage {
      pname = name;
      inherit (spec) version src;
      patches = spec.patches or [ ];
      inherit (spec) cargoHash;
    };

  candidates = lib.mapAttrs mkCandidate specs;

  probes = {
    gix-file-probe = rustPlatform.buildRustPackage {
      pname = "gix-file-probe";
      version = "0.1.0";
      src = ./gix-file-probe;
      cargoHash = "sha256-vlzdlYCnC6h48daCt64TJaMoAlyQDd6Cf+0xprZ39tQ=";
    };
  };

  guestCheck = vm-test.installedTest {
    name = "rust-cli-matrix";
    cpus = 2;
    init = ./guest-test.sh;
    contents = [
      busybox
      ca-certificates
      git
    ]
    ++ lib.attrValues candidates
    ++ lib.attrValues probes;
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
