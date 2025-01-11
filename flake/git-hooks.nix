{ inputs, ... }:
{
  imports = [ inputs.git-hooks.flakeModule ];

  perSystem =
    { config, ... }:
    {
      pre-commit.settings.hooks.treefmt = {
        enable = true;
        packageOverrides.treefmt = config.treefmt.build.wrapper;
      };

      make-shells.default.shellHook = config.pre-commit.installationScript;
    };
}
