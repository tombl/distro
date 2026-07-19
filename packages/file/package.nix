{
  pkgs,
  lib,
  stdenv,
  src,
  zlib,
  vm-test,
  busybox,
}:

let
  package = stdenv.mkDerivation (finalAttrs: {
    pname = "file";
    version = "5.48";
    inherit src;

    buildInputs = [ zlib ];

    # Cross builds cannot run the freshly built target `file` to compile the
    # magic database, so use a build-platform file of the same version. The
    # pinned source and pkgs.file must stay in lockstep.
    makeFlags = [ "FILE_COMPILE=${lib.getExe pkgs.file}" ];

    configureFlags = [
      "--disable-shared"
      "--enable-static"
      "--disable-libseccomp"
    ];

    # AC_FUNC_MMAP hard-codes "yes" for linux* hosts without running its probe,
    # so libmagic would compile in the mmap path for loading the magic database.
    # wasm has no mmap; force the malloc+read fallback (apprentice.c's #else).
    ac_cv_func_mmap_fixed_mapped = "no";

    passthru.checks =
      let
        # Sample files of known types for the detection test.
        fixtures = pkgs.runCommand "file-test-fixtures" { } ''
          mkdir -p $out/fixtures
          printf 'hello, this is plain ascii text\n' > $out/fixtures/hello.txt
          printf 'hello gzip payload\n' | ${pkgs.gzip}/bin/gzip -c > $out/fixtures/hello.gz
        '';
      in
      {
        detect = vm-test.vmTest {
          name = "file-detect";
          initramfs = vm-test.mkInitramfs {
            name = "file-detect";
            init = ./detect-test.sh;
            contents = [
              finalAttrs.finalPackage
              busybox
              fixtures
            ];
          };
        };
      };
  });
in
package
