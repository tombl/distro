{
  stdenv,
  src,
  vm-test,
  busybox,
}:

let
  package = stdenv.mkDerivation (finalAttrs: {
    pname = "mbedtls";
    version = "3.6.7";
    inherit src;

    # The `lib` target builds only the three static archives from the bundled
    # sources; the release tarball ships framework/exported.make and every
    # generated file, so no submodule fetch or Python codegen runs. The default
    # config needs no fork/mmap: entropy comes from getrandom()/`/dev/urandom`
    # (exercised by the VM check), threading is off, and there are no shared
    # objects to build on a static-only target.
    #
    # AR_DASH= tells the Makefile llvm-ar wants bare `src` operations rather
    # than the `-src` GNU form (its own comment names llvm-ar as the reason).
    buildPhase = ''
      runHook preBuild
      make -j$NIX_BUILD_CORES lib AR_DASH=
      runHook postBuild
    '';

    # The Makefile's install target also rebuilds the sample programs (no_test);
    # copy just the archives and headers to keep the port to the library.
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib $out/include
      cp library/libmbedcrypto.a library/libmbedx509.a library/libmbedtls.a $out/lib/
      cp -R include/mbedtls include/psa $out/include/
      runHook postInstall
    '';

    passthru.checks =
      let
        selftest = stdenv.mkDerivation {
          pname = "mbedtls-selftest";
          inherit (finalAttrs) version;
          dontUnpack = true;
          buildInputs = [ finalAttrs.finalPackage ];
          buildPhase = ''
            $CC -Wall -Wextra -Werror -o selftest ${./tests/selftest.c} \
              -lmbedtls -lmbedx509 -lmbedcrypto
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp selftest $out/bin/
          '';
        };
      in
      {
        selftest = vm-test.vmTest {
          name = "mbedtls-selftest";
          initramfs = vm-test.mkInitramfs {
            name = "mbedtls-selftest";
            init = ./tests/selftest-test.sh;
            contents = [
              busybox
              selftest
            ];
          };
        };
      };
  });
in
package
