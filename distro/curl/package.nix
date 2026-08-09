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
