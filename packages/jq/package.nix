{
  lib,
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-1.7.1.tar.gz";
    hash = "sha256-Ti1rQ7Va0oTE4Z0ouYfQS+yMNX3nFQtHfVkIYBHg3O4=";
  },
  vm-test,
  busybox,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "jq";
  version = "1.7.1";
  inherit src;
  outputs = [
    "out"
    "dev"
  ];
  apkPackages = {
    main = { };
    dev = {
      output = "dev";
    };
  };

  configureFlags = [
    # Keep the guest-facing build configuration free of the Nix dev-output
    # path; installFlags stages the headers in that output below.
    "--includedir=/usr/include"
    "--disable-shared"
    "--disable-docs"
    # No cross-built system oniguruma exists; build the bundled copy as a
    # sub-package so regex filters keep working.
    "--with-oniguruma=builtin"
  ];

  # The generic configure hook adds --includedir=$dev before configureFlags.
  # jq records its complete configure argv in the executable, so even an
  # overridden value creates an out -> dev reference and a multi-output cycle.
  # Supply the cross tuple explicitly and never put the dev store path in that
  # argv; installFlags below still stages development files into $dev.
  configurePhase = ''
    runHook preConfigure
    ./configure \
      --prefix="$out" \
      ${lib.escapeShellArgs finalAttrs.configureFlags} \
      --build=${lib.escapeShellArg stdenv.buildPlatform.config} \
      --host=${lib.escapeShellArg stdenv.hostPlatform.config}
    runHook postConfigure
  '';

  installFlags = [ "includedir=$(dev)/include" ];

  postInstall = ''
    moveToOutput bin/onig-config "$dev"
    moveToOutput 'lib/*.a' "$dev"
    moveToOutput 'lib/*.la' "$dev"
  '';

  passthru.checks =
    let
      check =
        name: init:
        vm-test.installedTest {
          name = "jq-${name}";
          inherit init;
          contents = [
            finalAttrs.finalPackage
            busybox
          ];
        };
    in
    {
      filters = check "filters" ./filters-test.sh;
    };
})
