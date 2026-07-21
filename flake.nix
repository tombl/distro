{
  description = "Packages for Linux on WebAssembly";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    # keep-sorted start block=yes
    busybox-src = {
      url = "github:tombl/busybox";
      flake = false;
    };
    bzip2-src = {
      url = "https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz";
      flake = false;
    };
    coreutils-src = {
      url = "https://ftp.gnu.org/gnu/coreutils/coreutils-9.7.tar.xz";
      flake = false;
    };
    curl-src = {
      url = "https://curl.se/download/curl-8.21.0.tar.xz";
      flake = false;
    };
    diffutils-src = {
      url = "https://ftp.gnu.org/gnu/diffutils/diffutils-3.10.tar.xz";
      flake = false;
    };
    dropbear-src = {
      url = "https://matt.ucc.asn.au/dropbear/releases/dropbear-2026.92.tar.bz2";
      flake = false;
    };
    file-src = {
      url = "https://astron.com/pub/file/file-5.48.tar.gz";
      flake = false;
    };
    findutils-src = {
      url = "https://ftp.gnu.org/gnu/findutils/findutils-4.10.0.tar.xz";
      flake = false;
    };
    gawk-src = {
      url = "https://ftp.gnu.org/gnu/gawk/gawk-5.3.1.tar.xz";
      flake = false;
    };
    git-src = {
      url = "https://www.kernel.org/pub/software/scm/git/git-2.55.0.tar.xz";
      flake = false;
    };
    grep-src = {
      url = "https://ftp.gnu.org/gnu/grep/grep-3.11.tar.xz";
      flake = false;
    };
    jq-src = {
      url = "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-1.7.1.tar.gz";
      flake = false;
    };
    less-src = {
      url = "https://ftp.gnu.org/gnu/less/less-668.tar.gz";
      flake = false;
    };
    linux-src = {
      url = "github:tombl/linux/safari-memory";
      flake = false;
    };
    llvm-src = {
      url = "github:tombl/llvm-project/wasm-linux";
      flake = false;
    };
    lua-src = {
      url = "https://www.lua.org/ftp/lua-5.4.8.tar.gz";
      flake = false;
    };
    make-src = {
      url = "https://ftp.gnu.org/gnu/make/make-4.4.1.tar.gz";
      flake = false;
    };
    mbedtls-src = {
      url = "https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2";
      flake = false;
    };
    musl-src = {
      url = "github:tombl/musl/platform-core";
      flake = false;
    };
    ncurses-src = {
      url = "https://ftp.gnu.org/gnu/ncurses/ncurses-6.6.tar.gz";
      flake = false;
    };
    openssl-src = {
      url = "https://github.com/openssl/openssl/releases/download/openssl-3.5.7/openssl-3.5.7.tar.gz";
      flake = false;
    };
    patch-src = {
      url = "https://ftp.gnu.org/gnu/patch/patch-2.7.6.tar.xz";
      flake = false;
    };
    python-src = {
      url = "https://www.python.org/ftp/python/3.13.14/Python-3.13.14.tar.xz";
      flake = false;
    };
    quickjs-src = {
      url = "https://github.com/quickjs-ng/quickjs/archive/refs/tags/v0.15.1.tar.gz";
      flake = false;
    };
    readline-src = {
      url = "https://ftp.gnu.org/gnu/readline/readline-8.3.tar.gz";
      flake = false;
    };
    sed-src = {
      url = "https://ftp.gnu.org/gnu/sed/sed-4.9.tar.xz";
      flake = false;
    };
    sqlite-src = {
      url = "https://sqlite.org/2025/sqlite-autoconf-3510000.tar.gz";
      flake = false;
    };
    tar-src = {
      url = "https://ftp.gnu.org/gnu/tar/tar-1.35.tar.xz";
      flake = false;
    };
    util-linux-src = {
      url = "https://www.kernel.org/pub/linux/utils/util-linux/v2.42/util-linux-2.42.2.tar.xz";
      flake = false;
    };
    vim-src = {
      url = "https://github.com/vim/vim/archive/refs/tags/v9.1.2148.tar.gz";
      flake = false;
    };
    xz-src = {
      url = "https://github.com/tukaani-project/xz/releases/download/v5.6.4/xz-5.6.4.tar.gz";
      flake = false;
    };
    zlib-src = {
      url = "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz";
      flake = false;
    };
    zstd-src = {
      url = "https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-1.5.6.tar.gz";
      flake = false;
    };
    # keep-sorted end
  };

  nixConfig = {
    extra-substituters = [ "https://linuxwasm.cachix.org" ];
    extra-trusted-public-keys = [
      "linuxwasm.cachix.org-1:+z2SehaESo/3sYp7afTgyXBHUkSj/Y+BokzAkWZEmeM="
    ];
  };

  outputs =
    { self, nixpkgs, ... }@inputs:
    let
      inherit (nixpkgs) lib;
      eachSystem =
        fn:
        lib.genAttrs
          [
            "x86_64-linux"
            "aarch64-linux"
            "aarch64-darwin"
          ]
          (
            system:
            fn {
              pkgs = import nixpkgs { inherit system; };
              wasmpkgs = self.legacyPackages.${system};
              formatter = self.formatter.${system};
            }
          );
      isPackage =
        _name: value:
        lib.isDerivation value || (builtins.isAttrs value && lib.isDerivation (value.package or null));
      packageFrom = _name: value: if lib.isDerivation value then value else value.package;
    in
    {
      # The package scope is the product. It contains owner-oriented package
      # sets and non-derivation helpers, hence legacyPackages rather than only
      # the flat packages output.
      legacyPackages = eachSystem ({ pkgs, ... }: import ./packages { inherit pkgs inputs; });

      # legacyPackages preserves the owner-oriented package sets. The packages
      # output projects each set's primary derivation back to the conventional
      # flat flake interface, so `nix build .#site` remains the obvious command
      # while `legacyPackages.${system}.site.image.rootfs` stays navigable.
      packages = eachSystem (
        { wasmpkgs, ... }: lib.mapAttrs packageFrom (lib.filterAttrs isPackage wasmpkgs)
      );

      checks = eachSystem (
        {
          pkgs,
          wasmpkgs,
          formatter,
        }:
        import ./checks.nix { inherit lib; } wasmpkgs
        // {
          formatting = pkgs.runCommand "treefmt-check" { nativeBuildInputs = [ formatter ]; } ''
            cp -r ${self} tree
            chmod -R u+w tree
            cd tree
            treefmt --ci
            touch $out
          '';
        }
      );

      formatter = eachSystem ({ pkgs, ... }: import ./formatter.nix { inherit pkgs; });

      devShells = eachSystem (
        {
          pkgs,
          wasmpkgs,
          formatter,
        }:
        {
          default = pkgs.mkShellNoCC {
            packages = [
              formatter
              wasmpkgs.llvm-toolchain
              pkgs.cmake
              pkgs.ninja
              pkgs.nodejs
              pkgs.pnpm_11
            ];
            env.sysroot = "${wasmpkgs.sysroot}";
          };

          ci = pkgs.mkShellNoCC {
            packages = [
              pkgs.jq
              pkgs.nix-eval-jobs
              pkgs.nodejs
              pkgs.pnpm_11
              pkgs.wrangler
            ];
          };
        }
      );

      apps = eachSystem (
        { pkgs, wasmpkgs, ... }:
        {
          runner = {
            type = "app";
            program = lib.getExe wasmpkgs.runner.package;
          };

          default = self.apps.${pkgs.stdenv.hostPlatform.system}.runner;
        }
      );

    };
}
