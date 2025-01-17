{ inputs, ... }:
{
  imports = [ inputs.make-shell.flakeModules.default ];

  perSystem =
    { pkgs, ... }:
    {
      make-shells.ci = {
        packages = with pkgs; [
          attic-client
          jq
          nix-eval-jobs
          nix-fast-build
        ];
      };
    };
}
