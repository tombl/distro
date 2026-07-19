{
  stdenv,
  src,
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
        vm-test.vmTest {
          name = "jq-${name}";
          initramfs = vm-test.mkInitramfs {
            name = "jq-${name}";
            inherit init;
            contents = [
              finalAttrs.finalPackage
              busybox
            ];
          };
        };
    in
    {
      filters = check "filters" ./filters-test.sh;
    };
})
