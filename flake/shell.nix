{ inputs, ... }:
{
  imports = [ inputs.make-shell.flakeModules.default ];

  perSystem =
    { pkgs, ... }:
    {
      make-shells.default = {
        stdenv = pkgs.stdenvNoCC;
      };

      make-shells.ci = {
        stdenv = pkgs.stdenvNoCC;
        packages = with pkgs; [
          attic-client
          jq
          nix-eval-jobs
          nix-fast-build
        ];
      };
    };
}
