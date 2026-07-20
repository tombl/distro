{
  stdenv,
  src,
  mbedtls,
  zlib,
  vm-test,
  busybox,
}:

let
  package = stdenv.mkDerivation (finalAttrs: {
    pname = "curl";
    version = "8.21.0";
    inherit src;

    buildInputs = [
      mbedtls
      zlib
    ];

    # The guest kernel does not implement eventfd (returns ENOSYS) and rejects
    # AF_UNIX socketpair (EAFNOSUPPORT). curl's multi handle prefers eventfd for
    # its internal wakeup and, when it cannot create one, aborts handle creation
    # in a way the easy interface reports as CURLE_OUT_OF_MEMORY on every
    # transfer. The stdenv CONFIG_SITE reports eventfd absent on the pinned
    # kernel, making curl fall back to pipe(), which the guest supports.

    # Static-only, mbedTLS backend, zlib for content encoding. Everything that
    # would pull in an unavailable transport or a library we do not ship is
    # turned off explicitly so the cross configure cannot latch onto a stray
    # host copy. Plain HTTP/HTTPS/FILE transfers need no fork; the threaded
    # resolver is disabled so name lookups stay in-process (numeric addresses
    # in the VM check resolve without DNS regardless). No CA store exists in the
    # guest, so the default bundle detection and the embedded bundle are off;
    # TLS trust is not exercised in the sandbox (see mbedtls selftests).
    configureFlags = [
      "--disable-shared"
      "--enable-static"
      "--with-mbedtls=${mbedtls}"
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
      transfers = vm-test.vmTest {
        name = "curl-transfers";
        initramfs = vm-test.mkInitramfs {
          name = "curl-transfers";
          init = ./tests/transfers-test.sh;
          contents = [
            busybox
            finalAttrs.finalPackage
          ];
        };
      };
    };
  });
in
package
