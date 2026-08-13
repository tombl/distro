{
  bytes,
  lib,
  linux-guest,
  kernel,
  pkgs,
  playwright,
}:

let
  projects = [
    "chromium"
    "firefox"
  ];

  suite = pkgs.runCommand "bridge-site-tests" { } ''
    mkdir -p \
      $out/node_modules/@lowland/bytes \
      $out/node_modules/@lowland/kernel \
      $out/node_modules/@lowland/guest
    ${playwright.linkRuntime "$out"}
    cp ${./client.js} $out/client.js
    cp ${./playwright.config.js} $out/playwright.config.js
    cp ${./server.js} $out/server.js
    cp -r ${./public} $out/public
    cp -r ${./tests} $out/tests
    cp -r ${bytes}/dist $out/node_modules/@lowland/bytes/dist
    tar -xzf ${kernel}/package.tgz --strip-components=1 -C $out/node_modules/@lowland/kernel
    tar -xzf ${linux-guest.package}/package.tgz \
      --strip-components=1 -C $out/node_modules/@lowland/guest
    cp ${linux-guest.package.checks.tests.assets}/rootfs.erofs \
      $out/node_modules/@lowland/guest/rootfs.erofs
  '';

  check =
    project:
    playwright.mkCheck {
      name = "bridge-site-${project}";
      inherit project suite;
    };
in
assert playwright.assertCompatible ./package.json;
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
