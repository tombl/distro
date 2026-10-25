{
  bytes,
  lib,
  kernel,
  linux-guest,
  lowland,
  lowland-image,
  pkgs,
  playwright,
  test-assets,
}:

let
  check =
    {
      project,
      browser ? project,
      built ? { },
      assets ? [ ],
    }:
    playwright.mkCheck {
      name = "browser-tests-${project}";
      package = "@lowland/browser-tests";
      directory = "packages/browser-tests";
      paths = [ "apps/site/service-worker.js" ];
      assets = test-assets.select assets;
      inherit project browser built;
    };

  engine =
    project:
    check {
      inherit project;
      built = {
        inherit bytes kernel lowland;
        linux-guest = linux-guest.package;
        # lowland.spec.js imports the facade; it boots /rootfs.erofs itself.
        lowland-image = lowland-image.package;
      };
      assets = [
        "boot.cpio"
        "opfs-disk-worker.js"
        "posix-spawn-stress.erofs"
        "remote-vm.erofs"
        "rootfs.erofs"
        "scheduler-handoff.erofs"
      ];
    };
in
# The suite runs from the source tree, so the package itself is only the
# owner of its checks, one per project in playwright.config.js.
pkgs.runCommand "browser-tests" { } "mkdir $out"
// {
  checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
    lib.genAttrs [ "chromium" "firefox" "webkit" ] engine
    // {
      service-worker = check {
        project = "service-worker";
        browser = "chromium";
      };
      site-live = check {
        project = "site-live";
        browser = "chromium";
        assets = [
          "apk"
          "site"
        ];
      };
    }
  );
}
