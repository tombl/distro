{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://curl.se/download/curl-8.21.0.tar.xz";
    hash = "sha256-nrvbU5C6oeCMAecrEqYE3CNPyFVsTEqaqhhCoLe5fMo=";
  },
  openssl,
  zlib,
  vm-test,
  busybox,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "curl";
  version = "8.21.0";
  inherit src;

  buildInputs = [
    openssl
    zlib
  ];

  # curl's configure resolves OpenSSL through pkg-config whenever the staged
  # openssl.pc is reachable, and falls back to --with-openssl path probing when
  # pkg-config is absent. Those two paths embed different locations into the
  # installed metadata, so pkg-config's presence is part of the build contract:
  # declare it to make the resolution -- and therefore the produced metadata --
  # deterministic regardless of the build environment.
  nativeBuildInputs = [ pkgs.pkg-config ];

  # Static-only, OpenSSL backend, zlib for content encoding. Everything that
  # would pull in an unavailable transport or a library we do not ship is
  # turned off explicitly so the cross configure cannot latch onto a stray
  # host copy. Plain HTTP/HTTPS/FILE transfers need no fork; the threaded
  # resolver is disabled so name lookups stay in-process (numeric addresses
  # in the VM check resolve without DNS regardless). Guest HTTPS is bridged by
  # the host Fetch implementation, so the package carries no CA trust store.
  configureFlags = [
    "--disable-shared"
    "--enable-static"
    "--with-openssl=${openssl}"
    "--with-zlib=${zlib}"
    "--enable-http"
    "--enable-file"
    "--disable-threaded-resolver"
    "--disable-ares"
    "--disable-ldap"
    "--disable-ldaps"
    "--disable-manual"
    "--disable-docs"
    "--disable-ntlm"
    "--without-brotli"
    "--without-zstd"
    "--without-libpsl"
    "--without-libidn2"
    "--without-nghttp2"
    "--without-nghttp3"
    "--without-ngtcp2"
    "--without-libssh2"
    "--without-libssh"
    "--without-ca-bundle"
    "--without-ca-path"
    "--without-ca-embed"
  ];

  # Configure must find the Nix-staged OpenSSL and zlib while cross-building,
  # but the installed metadata (curl-config, libcurl.la, libcurl.pc) describes
  # the guest runtime. The build-time prefixes leak in through --with-openssl
  # and --with-zlib: curl-config echoes the full configure line, zlib's
  # detection records -L$prefix/lib, and OpenSSL's pkg-config metadata may or
  # may not have been used. Rewrite the two known build roots to the guest FHS
  # root wherever they appear. --replace-quiet, not --replace-fail, is
  # deliberate: pkg-config already yields guest paths for a file in some
  # configurations, and the build must not depend on which resolution path
  # configure took.
  postFixup = ''
    substituteInPlace "$out/bin/curl-config" "$out/lib/libcurl.la" \
      --replace-quiet "${openssl}/lib" /lib \
      --replace-quiet "${openssl}/include" /include \
      --replace-quiet "${zlib}/lib" /lib \
      --replace-quiet "${zlib}/include" /include \
      --replace-quiet ${openssl} / \
      --replace-quiet ${zlib} /
    substituteInPlace "$out/lib/pkgconfig/libcurl.pc" \
      --replace-quiet "${openssl}/lib" /lib \
      --replace-quiet "${openssl}/include" /include \
      --replace-quiet ${openssl} /
  '';

  passthru.apk.depends = [ "busybox" ];

  passthru.checks = {
    transfers = vm-test.installedTest {
      name = "curl-transfers";
      init = ./tests/transfers-test.sh;
      contents = [
        # curl-config and wcurl are shell scripts. Runnable distro images
        # always install BusyBox as their /bin/sh provider.
        busybox
        finalAttrs.finalPackage
      ];
    };
  };
})
