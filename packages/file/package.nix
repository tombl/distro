{
  pkgs,
  lib,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://astron.com/pub/file/file-5.48.tar.gz";
    hash = "sha256-9OtdGy2HegeyiCVUuDo75A0REr+Z0ReR3jk2ORVAgp0=";
  },
  zlib,
  vm-test,
  busybox,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "file";
  version = "5.48";
  inherit src;
  apk.replaces = [ busybox.apk ];

  buildInputs = [ zlib ];

  # Cross builds cannot run the freshly built target `file` to compile the
  # magic database, so use a build-platform file of the same version. The
  # pinned source and pkgs.file must stay in lockstep.
  makeFlags = [
    "FILE_COMPILE=${lib.getExe pkgs.file}"
    # APK payloads are rooted at /, so compile the guest path rather than the
    # Nix build-time prefix into libmagic.
    "pkgdatadir=/usr/share/misc"
  ];

  # Keep the compiled guest path above, but stage the database under $out so
  # the APK installs it at /usr/share/misc.
  installFlags = [ "pkgdatadir=$(out)/usr/share/misc" ];

  configureFlags = [
    "--disable-shared"
    "--enable-static"
    "--disable-libseccomp"
  ];

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
      detect = vm-test.installedTest {
        name = "file-detect";
        init = ./detect-test.sh;
        contents = [
          finalAttrs.finalPackage
          busybox
          fixtures
        ];
      };
    };
})
