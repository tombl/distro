{
  lib,
  linux,
  linux-guest,
  node-workspace,
  pkgs,
}:

let
  packageJson = builtins.fromJSON (builtins.readFile ./package.json);
  playwrightVersion = packageJson.devDependencies."@playwright/test";
  driverVersion = pkgs.playwright-driver.version;

  suite = pkgs.stdenvNoCC.mkDerivation {
    pname = "browser-tests-suite";
    version = "0.0.0";
    src = ../..;
    pnpmDeps = node-workspace.deps;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.pnpmConfigHook
      node-workspace.pnpm
    ];

    buildPhase = ''
      runHook preBuild

      pnpm --filter=@tombl/browser-tests check

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p \
        $out/node_modules/@playwright \
        $out/node_modules/@tombl/linux \
        $out/node_modules/@tombl/linux-guest
      cp packages/browser-tests/{app.js,index.html,playwright.config.js,server.js} $out/
      cp -r packages/browser-tests/tests $out/
      cp -r ${pkgs.playwright-test}/lib/node_modules/@playwright/test $out/node_modules/@playwright/test
      cp -r ${pkgs.playwright-test}/lib/node_modules/playwright $out/node_modules/playwright
      cp -r ${pkgs.playwright-test}/lib/node_modules/playwright-core $out/node_modules/playwright-core
      tar -xzf ${linux}/linux.tgz --strip-components=1 -C $out/node_modules/@tombl/linux
      tar -xzf ${linux-guest}/linux-guest.tgz --strip-components=1 -C $out/node_modules/@tombl/linux-guest

      runHook postInstall
    '';
  };

  fontconfig = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };

  browsersFor =
    project:
    pkgs.playwright-driver.selectBrowsers {
      withChromium = project == "all" || project == "chromium";
      withChromiumHeadlessShell = project == "all" || project == "chromium";
      withFirefox = project == "all" || project == "firefox";
      withWebkit = project == "all" || project == "webkit";
      withFfmpeg = false;
      fontconfig_file = fontconfig;
    };

  environment = project: ''
    export FONTCONFIG_FILE=${fontconfig}
    export HOME=$TMPDIR/home
    export PLAYWRIGHT_BROWSERS_PATH=${browsersFor project}
    export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu-24.04
    export PLAYWRIGHT_OUTPUT_DIR=$TMPDIR/test-results
    export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
    export WEBKIT_DISABLE_DMABUF_RENDERER=1
    export XDG_CACHE_HOME=$TMPDIR/cache
    export XDG_CONFIG_HOME=$TMPDIR/config
    mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"
  '';

  app = pkgs.writeShellScriptBin "browser-tests" ''
    set -euo pipefail

    workdir=$(mktemp -d)
    trap 'rm -rf "$workdir"' EXIT
    cp -r ${suite}/. "$workdir/"
    chmod -R u+w "$workdir"
    cd "$workdir"
    export TMPDIR="$workdir/tmp"
    mkdir "$TMPDIR"
    ${environment "all"}
    ${lib.getExe pkgs.nodejs} node_modules/@playwright/test/cli.js test --reporter=line "$@"
  '';
in
assert lib.assertMsg (playwrightVersion == driverVersion) ''
  packages/browser-tests pins @playwright/test ${playwrightVersion}, but nixpkgs playwright-driver is ${driverVersion}
'';
app
// {
  passthru = {
    inherit suite;
  };
}
