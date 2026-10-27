{
  lib,
  lowland,
  pkgs,
  playwright,
  test-assets,
}:

let
  check =
    project:
    playwright.mkCheck {
      name = "bridge-site-${project}";
      package = "@lowland/bridge-site";
      directory = "packages/bridge-site";
      built = {
        lowland = lowland.dist;
        assets = [
          lowland.assets.kernel
          lowland.assets.agent
        ];
      };
      assets = test-assets.select [ "rootfs.erofs" ];
      inherit project;
    };
in
pkgs.runCommand "bridge-site"
  {
    passthru = {
      checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
        lib.genAttrs [ "chromium" "firefox" ] check
      );
      client = ./client.js;
    };
  }
  ''
    mkdir -p $out
    cp -r ${./public}/. $out/
  ''
