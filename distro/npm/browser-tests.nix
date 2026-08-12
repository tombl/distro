{
  basic-init,
  bytes,
  lib,
  kernel,
  linux-guest,
  pkgs,
  playwright,
  site,
}:

let
  source = ../../packages/browser-tests;

  baseSuite = pkgs.runCommand "browser-tests" { } ''
    mkdir -p \
      $out/node_modules/@lowland/bytes \
      $out/node_modules/@lowland/kernel \
      $out/node_modules/@tombl/linux-guest
    ${playwright.linkRuntime "$out"}
    cp ${source}/app.js $out/app.js
    cp ${source}/index.html $out/index.html
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${site.package}/static/*/opfs-disk-worker.js $out/opfs-disk-worker.js
    cp ${basic-init.schedulerHandoffInitramfs} $out/scheduler-handoff.cpio
    cp ${basic-init.remoteMemoryInitramfs} $out/remote-vm.cpio
    cp ${source}/server.js $out/server.js
    cp ${linux-guest.package.checks.tests.assets}/rootfs.erofs $out/rootfs.erofs
    mkdir $out/tests
    cp ${source}/tests/boot.spec.js $out/tests/
    cp ${source}/tests/opfs-disk.spec.js $out/tests/
    cp ${source}/tests/remote-memory.spec.js $out/tests/
    cp ${source}/tests/spawn-stress.spec.js $out/tests/
    cp ${source}/tests/virtio-fs.spec.js $out/tests/
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

  check =
    project:
    playwright.mkCheck {
      name = "browser-tests-${project}";
      suite = baseSuite;
      inherit project;
    };

  siteSuite = pkgs.runCommand "site-browser-tests" { } ''
      mkdir -p $out/tests
      ${playwright.linkRuntime "$out"}
      cp ${source}/playwright.config.js $out/playwright.config.js
      cp ${source}/server.js $out/server.js
      cp ${source}/tests/site-live.spec.js $out/tests/site-live.spec.js
      cp -rL ${site.package}/. $out/
      # Production and previews fetch the independently published repository.
      # The integration test vendors the exact candidate repository so it can
      # validate an install before those packages have reached production.
      cp -rL ${site.repository} $out/apk
      # After installation the service worker controls the page, so Playwright's
      # page-level route cannot intercept guest fetches. Route only this test
      # artifact's package requests to the vendored candidate repository; the
      # production worker continues to fetch assets.low.land directly.
      substituteInPlace $out/service-worker.js \
        --replace-fail '  const { request } = event;' '  let { request } = event;' \
        --replace-fail '  const url = new URL(request.url);' '  let url = new URL(request.url);
    if (url.hostname === "assets.low.land" && url.pathname.startsWith("/apk/")) {
      request = new Request(new URL(url.pathname + url.search, location.origin), request);
      url = new URL(request.url);
    }'
  '';

  serviceWorkerSuite = pkgs.runCommand "service-worker-browser-tests" { } ''
    mkdir -p $out/tests
    ${playwright.linkRuntime "$out"}
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${source}/server.js $out/server.js
    cp ${source}/app.js $out/app.js
    cp ${source}/tests/service-worker.spec.js $out/tests/service-worker.spec.js
    cp ${source}/index.html $out/index.html
    cp ${../../apps/site/service-worker.js} $out/service-worker.js
  '';

  siteCheck = playwright.mkCheck {
    name = "browser-tests-site-live";
    project = "chromium";
    suite = siteSuite;
  };
  serviceWorkerCheck = playwright.mkCheck {
    name = "browser-tests-service-worker";
    project = "chromium";
    suite = serviceWorkerSuite;
  };
in
assert playwright.assertCompatible (source + "/package.json");
suite
