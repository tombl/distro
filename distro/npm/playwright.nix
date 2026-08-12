{ lib, pkgs }:

let
  driverVersion = pkgs.playwright-driver.version;
  fontconfig = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };

  runtime = pkgs.runCommand "playwright-test-runtime" { } ''
    mkdir -p $out/node_modules/@playwright
    cp -r ${pkgs.playwright-test}/lib/node_modules/@playwright/test $out/node_modules/@playwright/test
    cp -r ${pkgs.playwright-test}/lib/node_modules/playwright $out/node_modules/playwright
    cp -r ${pkgs.playwright-test}/lib/node_modules/playwright-core $out/node_modules/playwright-core
  '';

  browsersFor =
    project:
    pkgs.playwright-driver.selectBrowsers {
      withChromium = project == "chromium";
      withChromiumHeadlessShell = project == "chromium";
      withFirefox = project == "firefox";
      withWebkit = project == "webkit";
      withFfmpeg = false;
      fontconfig_file = fontconfig;
    };
in
{
  assertCompatible =
    packageJsonPath:
    let
      package = builtins.fromJSON (builtins.readFile packageJsonPath);
      playwrightVersion = package.devDependencies."@playwright/test";
    in
    lib.assertMsg (playwrightVersion == driverVersion) ''
      ${package.name} pins @playwright/test ${playwrightVersion}, but nixpkgs playwright-driver is ${driverVersion}
    '';

  linkRuntime = destination: ''
    mkdir -p ${destination}/node_modules
    ln -s ${runtime}/node_modules/@playwright ${destination}/node_modules/@playwright
    ln -s ${runtime}/node_modules/playwright ${destination}/node_modules/playwright
    ln -s ${runtime}/node_modules/playwright-core ${destination}/node_modules/playwright-core
  '';

  mkCheck =
    {
      name,
      project,
      suite,
    }:
    pkgs.runCommand name { nativeBuildInputs = [ pkgs.nodejs ]; } ''
      export TMPDIR="$NIX_BUILD_TOP/tmp"
      export HOME="$TMPDIR/home"
      export XDG_CACHE_HOME="$TMPDIR/cache"
      export XDG_CONFIG_HOME="$TMPDIR/config"
      mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"

      export __EGL_VENDOR_LIBRARY_FILENAMES=${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json
      export FONTCONFIG_FILE=${fontconfig}
      export LIBGL_ALWAYS_SOFTWARE=1
      export LIBGL_DRIVERS_PATH=${pkgs.mesa}/lib/dri
      export PLAYWRIGHT_BROWSERS_PATH=${browsersFor project}
      export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu-24.04
      export PLAYWRIGHT_OUTPUT_DIR="$TMPDIR/test-results"
      export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
      export WEBKIT_DISABLE_DMABUF_RENDERER=1

      cd ${suite}
      node node_modules/@playwright/test/cli.js test --project=${project} --reporter=line
      touch $out
    '';
}
