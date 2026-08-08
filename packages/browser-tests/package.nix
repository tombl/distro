{
  basic-init,
  lib,
  linux,
  linux-guest,
  pkgs,
}:

let
  packageJson = builtins.fromJSON (builtins.readFile ./package.json);
  playwrightVersion = packageJson.devDependencies."@playwright/test";
  driverVersion = pkgs.playwright-driver.version;

  suite =
    pkgs.runCommand "browser-tests"
      {
        passthru.checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (lib.genAttrs projects check);
      }
      ''
        mkdir -p \
          $out/node_modules/@playwright \
          $out/node_modules/@tombl/linux \
          $out/node_modules/@tombl/linux-guest
        cp ${./app.js} $out/app.js
        cp ${./index.html} $out/index.html
        cp ${./playwright.config.js} $out/playwright.config.js
        cp ${basic-init.schedulerHandoffInitramfs} $out/scheduler-handoff.cpio
        cp ${basic-init.remoteMemoryInitramfs} $out/remote-vm.cpio
        cp ${./server.js} $out/server.js
        cp ${linux-guest.package.checks.tests.assets}/rootfs.squashfs $out/rootfs.squashfs
        cp -r ${./tests} $out/tests
        cp -r ${pkgs.playwright-test}/lib/node_modules/@playwright/test $out/node_modules/@playwright/test
        cp -r ${pkgs.playwright-test}/lib/node_modules/playwright $out/node_modules/playwright
        cp -r ${pkgs.playwright-test}/lib/node_modules/playwright-core $out/node_modules/playwright-core
        tar -xzf ${linux}/linux.tgz --strip-components=1 -C $out/node_modules/@tombl/linux
        tar -xzf ${linux-guest.package}/linux-guest.tgz --strip-components=1 -C $out/node_modules/@tombl/linux-guest
      '';

  projects = [
    "chromium"
    "firefox"
    "webkit"
  ];

  fontconfig = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };

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

  environment = project: ''
    export __EGL_VENDOR_LIBRARY_FILENAMES=${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json
    export FONTCONFIG_FILE=${fontconfig}
    export HOME=$TMPDIR/home
    export LIBGL_ALWAYS_SOFTWARE=1
    export LIBGL_DRIVERS_PATH=${pkgs.mesa}/lib/dri
    export PLAYWRIGHT_BROWSERS_PATH=${browsersFor project}
    export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu-24.04
    export PLAYWRIGHT_OUTPUT_DIR=$TMPDIR/test-results
    export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
    export WEBKIT_DISABLE_DMABUF_RENDERER=1
    export XDG_CACHE_HOME=$TMPDIR/cache
    export XDG_CONFIG_HOME=$TMPDIR/config
    mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"
  '';

  check =
    project:
    pkgs.runCommand "browser-tests-${project}" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
      export TMPDIR="$NIX_BUILD_TOP/tmp"
      mkdir "$TMPDIR"
      ${environment project}
      cd ${suite}
      node node_modules/@playwright/test/cli.js test --project=${project} --reporter=line
      touch $out
    '';
in
assert lib.assertMsg (playwrightVersion == driverVersion) ''
  packages/browser-tests pins @playwright/test ${playwrightVersion}, but nixpkgs playwright-driver is ${driverVersion}
'';
suite
