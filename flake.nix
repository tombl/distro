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
    file-src = {
      url = "https://astron.com/pub/file/file-5.48.tar.gz";
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
      url = "github:tombl/linux";
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
    musl-src = {
      url = "github:tombl/musl";
      flake = false;
    };
    ncurses-src = {
      url = "https://ftp.gnu.org/gnu/ncurses/ncurses-6.6.tar.gz";
      flake = false;
    };
    readline-src = {
      url = "https://ftp.gnu.org/gnu/readline/readline-8.3.tar.gz";
      flake = false;
    };
    sqlite-src = {
      url = "https://sqlite.org/2025/sqlite-autoconf-3510000.tar.gz";
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

          flake-inputs =
            let
              lock = builtins.fromJSON (builtins.readFile ./flake.lock);

              # The root node is this flake itself, and is the only node with no source.
              nodes = builtins.attrValues (removeAttrs lock.nodes [ lock.root ]);

              # Relative path inputs resolve against their parent, so they can't be fetched
              # standalone — and they already live inside a source we root anyway.
              isFetchable =
                node: node.locked.type or null != "path" || builtins.substring 0 1 node.locked.path == "/";

              # Inputs are content-addressed on narHash, so nodes sharing one are the same
              # store path. Keying on it drops the duplicates that `follows` leaves behind.
              unique = builtins.listToAttrs (
                map (node: {
                  name = node.locked.narHash;
                  value = node;
                }) (builtins.filter isFetchable nodes)
              );

              # The same expression nix uses in its own call-flake.nix.
              fetchNode = node: (fetchTree (removeAttrs node.locked [ "dir" ])).outPath;

              sources = map fetchNode (builtins.attrValues unique);
            in
            # Interpolating the store paths makes them inputSrcs of this derivation, so
            # nix's reference scanner roots every input in the output's closure.
            pkgs.writeText "flake-inputs" (builtins.concatStringsSep "\n" sources);

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
