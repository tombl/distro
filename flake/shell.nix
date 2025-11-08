{ inputs, ... }:
{
  imports = [ inputs.make-shell.flakeModules.default ];

  perSystem =
    { pkgs, config, ... }:
    let
      inherit (config.legacyPackages) wasmpkgs hostpkgs;
    in
    {
      make-shells.default = {
        stdenv = pkgs.stdenvNoCC;
        packages = [
          pkgs.just
          hostpkgs.clang
          hostpkgs.lld
          hostpkgs.llvm
          hostpkgs.cmake
          (pkgs.writeShellScriptBin "hostcc" ''exec ${hostpkgs.clang-host}/bin/clang "$@"'')
        ];
        env = {
          inherit (wasmpkgs) sysroot;
        };
      };

      make-shells.ci = {
        stdenv = pkgs.stdenvNoCC;
        packages = [
          pkgs.jq
          pkgs.nix-eval-jobs
        ];
      };
    };
}
