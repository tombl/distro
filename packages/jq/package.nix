{
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

  configureFlags = [
    "--disable-shared"
    "--disable-docs"
    # No cross-built system oniguruma exists; build the bundled copy as a
    # sub-package so regex filters keep working.
    "--with-oniguruma=builtin"
  ];

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
