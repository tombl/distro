{
  bytes,
  lib,
  linux-guest,
  kernel,
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
        inherit bytes kernel;
        linux-guest = linux-guest.package;
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
