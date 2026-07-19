{
  stdenv,
  src,
  vm-test,
  busybox,
}:

let
  package = stdenv.mkDerivation (finalAttrs: {
    pname = "zlib";
    version = "1.3.1";
    inherit src;

    # zlib's hand-written configure is not autoconf; it rejects the --build/--host
    # flags nixpkgs adds for cross compilation.
    configurePlatforms = [ ];

    # Static-only target: no shared library, no PIC shims.
    dontDisableStatic = true;
    configureFlags = [ "--static" ];

    passthru.checks =
      let
        roundtrip = stdenv.mkDerivation {
          pname = "zlib-roundtrip-test";
          version = "0.0.0";
          dontUnpack = true;
          buildInputs = [ finalAttrs.finalPackage ];
          buildPhase = ''
            $CC -Wall -Wextra -Werror -o roundtrip ${./tests/roundtrip.c} -lz
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp roundtrip $out/bin/
          '';
        };
      in
      {
        roundtrip = vm-test.vmTest {
          name = "zlib-roundtrip";
          initramfs = vm-test.mkInitramfs {
            name = "zlib-roundtrip";
            init = ./tests/roundtrip-test.sh;
            contents = [
              busybox
              roundtrip
            ];
          };
        };
      };
  });
in
package
