{
  description = "Packages for Linux on WebAssembly";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  nixConfig = {
    extra-substituters = [ "https://linuxwasm.cachix.org" ];
    extra-trusted-public-keys = [
      "linuxwasm.cachix.org-1:+z2SehaESo/3sYp7afTgyXBHUkSj/Y+BokzAkWZEmeM="
    ];
  };

  outputs =
    { self, nixpkgs }:
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
      legacyPackages = eachSystem (
        { pkgs, ... }:
        import ./distro {
          inherit pkgs;
          sourceVersion = toString self.lastModified;
        }
      );

      # legacyPackages preserves the owner-oriented package sets. The packages
      # output projects each set's primary derivation back to the conventional
      # flat flake interface, so `nix build .#site` remains the obvious command
      # while `legacyPackages.${system}.site.rootfs` stays navigable.
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

      # All validations remain conventional flake checks. This view only gives
      # CI enough semantic information to isolate scheduler-sensitive checks;
      # derivations opt in with passthru.ci.heavy rather than naming conventions.
      ciJobs = eachSystem (
        { pkgs, ... }:
        let
          system = pkgs.stdenv.hostPlatform.system;
          checks = self.checks.${system};
          isHeavy = _name: check: check.ci.heavy or false;
        in
        {
          builds = self.packages.${system};
          checks = lib.filterAttrs (name: check: !(isHeavy name check)) checks;
          heavyChecks = lib.filterAttrs isHeavy checks;
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

          # The deploy shell: sign the apk repository and publish the site to
          # Cloudflare. apk-tools-host is the repo's own apk, so the signed
          # index matches what the wasm client expects.
          ci = pkgs.mkShellNoCC {
            packages = [
              pkgs.jq
              pkgs.rclone
              wasmpkgs.apk-tools-host
              pkgs.wrangler
            ];
          };

        }
      );

      apps = eachSystem (
        { pkgs, wasmpkgs, ... }:
        let
          siteDeploy = pkgs.writeShellScript "site-deploy" ''
            set -euo pipefail
            root="$(git rev-parse --show-toplevel)"
            cd "$root"
            chmod -R u+w deploy 2>/dev/null || true
            rm -rf deploy
            cp -rL ${wasmpkgs.site.package} deploy
            chmod -R u+w deploy
            exec ${pkgs.wrangler}/bin/wrangler \
              "$@" --config distro/site/wrangler.toml
          '';
          docsDeploy = pkgs.writeShellScript "docs-deploy" ''
            set -euo pipefail
            root="$(git rev-parse --show-toplevel)"
            cd "$root"
            chmod -R u+w docs-deploy 2>/dev/null || true
            rm -rf docs-deploy
            cp -rL ${wasmpkgs.docs.package} docs-deploy
            chmod -R u+w docs-deploy
            exec ${pkgs.wrangler}/bin/wrangler \
              "$@" --config apps/docs/wrangler.toml
          '';
        in
        {
          artifacts = {
            type = "app";
            program = lib.getExe (
              pkgs.writeShellApplication {
                name = "materialize-artifacts";
                runtimeInputs = [ pkgs.coreutils ];
                text = ''
                  if [[ ! -f package.json || ! -d packages/kernel ]]; then
                    echo "artifacts must be materialized from the repository root" >&2
                    exit 1
                  fi
                  test_assets=${wasmpkgs.linux-guest.package.checks.tests.assets}
                  install -Dm0644 ${wasmpkgs.linux}/vmlinux.wasm packages/kernel/vmlinux.wasm
                  for asset in "$test_assets"/*; do
                    install -Dm0644 "$asset" "packages/linux-guest/$(basename "$asset")"
                  done
                '';
              }
            );
          };

          runner = {
            type = "app";
            program = lib.getExe wasmpkgs.runner.package;
          };

          wrangler-deploy = {
            type = "app";
            program = "${pkgs.writeShellScript "wrangler-deploy" ''
              exec ${siteDeploy} deploy "$@"
            ''}";
          };

          wrangler-preview = {
            type = "app";
            program = "${pkgs.writeShellScript "wrangler-preview" ''
              exec ${siteDeploy} versions upload "$@"
            ''}";
          };

          docs-wrangler-deploy = {
            type = "app";
            program = "${pkgs.writeShellScript "docs-wrangler-deploy" ''
              exec ${docsDeploy} deploy "$@"
            ''}";
          };

          docs-wrangler-preview = {
            type = "app";
            program = "${pkgs.writeShellScript "docs-wrangler-preview" ''
              exec ${docsDeploy} versions upload "$@"
            ''}";
          };

          default = self.apps.${pkgs.stdenv.hostPlatform.system}.runner;
        }
      );

    };
}
