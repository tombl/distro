{
  bytes,
  lib,
  linux-guest,
  kernel,
  pkgs,
}:

let
  packageJson = builtins.fromJSON (builtins.readFile ./package.json);
  playwrightVersion = packageJson.devDependencies."@playwright/test";
  driverVersion = pkgs.playwright-driver.version;

  projects = [
    "chromium"
    "firefox"
  ];

  fontconfig = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };

  browsersFor =
    project:
    pkgs.playwright-driver.selectBrowsers {
      withChromium = project == "chromium";
      withChromiumHeadlessShell = project == "chromium";
      withFirefox = project == "firefox";
      withWebkit = false;
      withFfmpeg = false;
      fontconfig_file = fontconfig;
    };

  suite = pkgs.runCommand "bridge-site-tests" { } ''
    mkdir -p \
      $out/.assets \
      $out/node_modules/@lowland/bytes \
      $out/node_modules/@lowland/kernel \
      $out/node_modules/@playwright \
      $out/node_modules/@tombl/linux-guest
    cp ${./client.js} $out/client.js
    cp ${./playwright.config.js} $out/playwright.config.js
    cp ${./server.js} $out/server.js
    cp -r ${./public} $out/public
    cp -r ${./tests} $out/tests
    cp ${linux-guest.package.checks.tests.assets}/rootfs.erofs $out/.assets/rootfs.erofs
    cp -r ${pkgs.playwright-test}/lib/node_modules/@playwright/test $out/node_modules/@playwright/test
    cp -r ${pkgs.playwright-test}/lib/node_modules/playwright $out/node_modules/playwright
    cp -r ${pkgs.playwright-test}/lib/node_modules/playwright-core $out/node_modules/playwright-core
    cp -r ${bytes}/dist $out/node_modules/@lowland/bytes/dist
    tar -xzf ${kernel}/kernel.tgz --strip-components=1 -C $out/node_modules/@lowland/kernel
    tar -xzf ${linux-guest.package}/linux-guest.tgz \
      --strip-components=1 -C $out/node_modules/@tombl/linux-guest
  '';

  check =
    project:
    pkgs.runCommand "bridge-site-${project}" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
      export __EGL_VENDOR_LIBRARY_FILENAMES=${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json
      export FONTCONFIG_FILE=${fontconfig}
      export LIBGL_ALWAYS_SOFTWARE=1
      export LIBGL_DRIVERS_PATH=${pkgs.mesa}/lib/dri
      export PLAYWRIGHT_BROWSERS_PATH=${browsersFor project}
      export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu-24.04
      export PLAYWRIGHT_OUTPUT_DIR=$NIX_BUILD_TOP/test-results
      export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
      export XDG_CACHE_HOME=$NIX_BUILD_TOP/cache
      export XDG_CONFIG_HOME=$NIX_BUILD_TOP/config
      mkdir -p "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"
      cd ${suite}
      node node_modules/@playwright/test/cli.js test --project=${project} --reporter=line
      touch $out
    '';
in
assert lib.assertMsg (playwrightVersion == driverVersion) ''
  packages/bridge-site pins @playwright/test ${playwrightVersion}, but nixpkgs playwright-driver is ${driverVersion}
'';
pkgs.runCommand "bridge-site"
  {
    passthru = {
      checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (lib.genAttrs projects check);
      client = ./client.js;
    };
  }
  ''
    mkdir -p $out
    cp -r ${./public}/. $out/
  ''
