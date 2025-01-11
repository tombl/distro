{ inputs, ... }:
{
  imports = [ inputs.make-shell.flakeModules.default ];

  # perSystem =
  #   { pkgs, ... }:
  #   {
  #     make-shells.default = {
  #       packages = with pkgs; [
  #         # keep-sorted start
  #         # keep-sorted end
  #       ];
  #     };
  #   };
}
