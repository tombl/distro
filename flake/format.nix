{ inputs, ... }:
{
  imports = [ inputs.treefmt-nix.flakeModule ];

  perSystem =
    { config, ... }:
    {
      treefmt = {
        projectRootFile = "flake.nix";
        settings = {
          global.excludes = [ ];
        };
        programs = {
          # keep-sorted start
          actionlint.enable = true;
          deadnix.enable = true;
          just.enable = true;
          keep-sorted.enable = true;
          nixfmt.enable = true;
          prettier.enable = true;
          shellcheck.enable = true;
          shfmt.enable = true;
          statix.enable = true;
          # keep-sorted end
        };
      };

      make-shells.default.packages = [ config.treefmt.build.wrapper ];
    };
}
