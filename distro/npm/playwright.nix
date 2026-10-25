{
  lib,
  node-workspace,
  pkgs,
}:

let
  driverVersion = pkgs.playwright-driver.version;
  fontconfig = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };

  browsersFor =
    browser:
    pkgs.playwright-driver.selectBrowsers {
      withChromium = browser == "chromium";
      withChromiumHeadlessShell = browser == "chromium";
      withFirefox = browser == "firefox";
      withWebkit = browser == "webkit";
      withFfmpeg = false;
      fontconfig_file = fontconfig;
    };
in
{
  # Runs one project of a package's Playwright suite with `pnpm test`, using
  # the workspace's @playwright/test and nixpkgs' matching browser builds.
  mkCheck =
    {
      name,
      package,
      directory,
      project,
      browser ? project,
      built,
      assets,
      paths ? [ ],
    }:
    node-workspace.mkTest {
      inherit name built assets;
      paths = [ directory ] ++ paths;
      env = {
        __EGL_VENDOR_LIBRARY_FILENAMES = "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
        FONTCONFIG_FILE = fontconfig;
        LIBGL_ALWAYS_SOFTWARE = "1";
        LIBGL_DRIVERS_PATH = "${pkgs.mesa}/lib/dri";
        PLAYWRIGHT_BROWSERS_PATH = browsersFor browser;
        PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu-24.04";
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
        WEBKIT_DISABLE_DMABUF_RENDERER = "1";
      };
      command = ''
        export HOME="$TMPDIR/home" XDG_CACHE_HOME="$TMPDIR/cache" XDG_CONFIG_HOME="$TMPDIR/config"
        export PLAYWRIGHT_OUTPUT_DIR="$TMPDIR/test-results"
        mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"

        # The browser builds are tied to one Playwright release.
        version=$(node -p 'require("./${directory}/node_modules/@playwright/test/package.json").version')
        if [ "$version" != ${lib.escapeShellArg driverVersion} ]; then
          echo "the pnpm catalog pins @playwright/test $version, but nixpkgs playwright-driver is ${driverVersion}" >&2
          exit 1
        fi

        pnpm --filter=${package} test --project=${project} --reporter=line
      '';
    };
}
