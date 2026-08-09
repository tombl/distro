{
  basic-init,
  bytes,
  lib,
  kernel,
  linux-guest,
  pkgs,
  site,
}:

let
  source = ../../packages/browser-tests;
  packageJson = builtins.fromJSON (builtins.readFile (source + "/package.json"));
  playwrightVersion = packageJson.devDependencies."@playwright/test";
  driverVersion = pkgs.playwright-driver.version;

  baseSuite = pkgs.runCommand "browser-tests" { } ''
    mkdir -p \
      $out/node_modules/@playwright \
      $out/node_modules/@lowland/bytes \
      $out/node_modules/@lowland/kernel \
      $out/node_modules/@tombl/linux-guest
    cp ${source}/app.js $out/app.js
    cp ${source}/index.html $out/index.html
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${basic-init.schedulerHandoffInitramfs} $out/scheduler-handoff.cpio
    cp ${basic-init.remoteMemoryInitramfs} $out/remote-vm.cpio
    cp ${source}/server.js $out/server.js
    cp ${linux-guest.package.checks.tests.assets}/rootfs.erofs $out/rootfs.erofs
    mkdir $out/tests
    cp ${source}/tests/boot.spec.js $out/tests/
    cp ${source}/tests/remote-memory.spec.js $out/tests/
    cp ${source}/tests/spawn-stress.spec.js $out/tests/
    cp ${source}/tests/virtio-fs.spec.js $out/tests/
    cp -r ${pkgs.playwright-test}/lib/node_modules/@playwright/test $out/node_modules/@playwright/test
    cp -r ${pkgs.playwright-test}/lib/node_modules/playwright $out/node_modules/playwright
    cp -r ${pkgs.playwright-test}/lib/node_modules/playwright-core $out/node_modules/playwright-core
    cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
    cp -r ${kernel}/. $out/node_modules/@lowland/kernel/
    tar -xzf ${linux-guest.package}/linux-guest.tgz --strip-components=1 -C $out/node_modules/@tombl/linux-guest
  '';

  suite = baseSuite // {
    checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
      (lib.genAttrs projects check)
      // {
        site-live = siteCheck;
        service-worker = serviceWorkerCheck;
      }
    );
  };

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
      cd ${baseSuite}
      node node_modules/@playwright/test/cli.js test --project=${project} --reporter=line
      touch $out
    '';

  siteSuite = pkgs.runCommand "site-browser-tests" { } ''
    mkdir -p $out/node_modules/@playwright $out/tests
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${source}/server.js $out/server.js
    cp ${source}/tests/site-live.spec.js $out/tests/site-live.spec.js
    cp -r ${pkgs.playwright-test}/lib/node_modules/@playwright/test $out/node_modules/@playwright/test
    cp -r ${pkgs.playwright-test}/lib/node_modules/playwright $out/node_modules/playwright
    cp -r ${pkgs.playwright-test}/lib/node_modules/playwright-core $out/node_modules/playwright-core
    cp -rL ${site.package}/. $out/
  '';

  serviceWorkerSuite = pkgs.runCommand "service-worker-browser-tests" { } ''
    mkdir -p $out/node_modules/@playwright $out/tests
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${source}/server.js $out/server.js
    cp ${source}/app.js $out/app.js
    cp ${source}/tests/service-worker.spec.js $out/tests/service-worker.spec.js
    cp -r ${pkgs.playwright-test}/lib/node_modules/@playwright/test $out/node_modules/@playwright/test
    cp -r ${pkgs.playwright-test}/lib/node_modules/playwright $out/node_modules/playwright
    cp -r ${pkgs.playwright-test}/lib/node_modules/playwright-core $out/node_modules/playwright-core
    cp ${source}/index.html $out/index.html
    cp ${../../apps/site/service-worker.js} $out/service-worker.js
  '';

  chromiumCheck =
    name: testSuite:
    pkgs.runCommand name { nativeBuildInputs = [ pkgs.nodejs ]; } ''
      export TMPDIR="$NIX_BUILD_TOP/tmp"
      mkdir "$TMPDIR"
      ${environment "chromium"}
      cd ${testSuite}
      node node_modules/@playwright/test/cli.js test --project=chromium --reporter=line
      touch $out
    '';

  siteCheck = chromiumCheck "browser-tests-site-live" siteSuite;
  serviceWorkerCheck = chromiumCheck "browser-tests-service-worker" serviceWorkerSuite;
in
assert lib.assertMsg (playwrightVersion == driverVersion) ''
  packages/browser-tests pins @playwright/test ${playwrightVersion}, but nixpkgs playwright-driver is ${driverVersion}
'';
suite
