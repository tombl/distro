{
  pkgs,
  inputs,
  self,
}:

let
  config = {
    projectRootFile = "flake.nix";
    programs = {
      just.enable = true;
      shfmt.enable = true;
      oxfmt.enable = true;
      nixfmt.enable = true;
      statix.enable = true;
      deadnix.enable = true;
      actionlint.enable = true;
      shellcheck.enable = true;
    };
  };

  treefmt = inputs.treefmt-nix.lib.evalModule pkgs config;
in
treefmt.config.build.wrapper
// {
  checks.treefmt = treefmt.config.build.check self;
}
