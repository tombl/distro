{ inputs, ... }:
{
  imports = [ inputs.make-shell.flakeModules.default ];

  perSystem =
    { pkgs, ... }:
    {
      make-shells.ci = {
        packages = with pkgs; [
          attic-client
          nix-fast-build
        ];
      };
    };
}
