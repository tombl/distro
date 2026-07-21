{
  pkgs,
  stdenv,
  src,
  vm-test,
  busybox,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "openssl";
  version = "3.5.7";
  inherit src;

  # apps/speed.c calls mlock() under a bare OPENSSL_SYS_LINUX guard, but
  # musl-wasm declares no <sys/mman.h> functions (they sit behind #ifndef
  # __wasm__), so the CLI would not compile. The patch makes `-mlock` report
  # "not supported" on wasm like the other platforms that lack it.
  patches = [ ./speed-no-mlock-on-wasm.patch ];

  # Configure and the generated build scripts are perl; the wasm stdenv brings
  # no interpreter of its own, and #!/usr/bin/env perl has no /usr/bin/env in
  # the sandbox, so hand Configure to the build-platform perl directly.
  nativeBuildInputs = [ pkgs.perl ];

  # OpenSSL ships its own perl Configure rather than autotools, so it never
  # reads the stdenv's CONFIG_SITE (the mmap/dlopen answers there are for
  # autoconf). We drive Configure by hand instead of the generic
  # configurePhase, which would append --host/--build/--prefix flags Configure
  # rejects. CC/AR/RANLIB come from the wasm toolchain the stdenv exports.
  #
  # Base target linux-generic32: the wasm32 host is 32-bit, has no OpenSSL
  # assembly (no asm_arch in this target, so Configure takes the pure-C bignum
  # and hash paths), and uses pthreads, which musl provides on this platform.
  #
  # Disabled, and why each is forced rather than left to detection:
  #   no-shared, no-dso, no-dynamic-engine  -- static-only target, no dlopen;
  #       nothing can be loaded at runtime, so the loader machinery is dead
  #       weight that would also pull in -ldl paths.
  #   no-async     -- the async job scheduler unwinds with makecontext/
  #       swapcontext, which musl does not implement on wasm.
  #   no-afalgeng  -- linux-generic32 enables the AF_ALG kernel-crypto engine
  #       by default; the guest has no AF_ALG socket, and we cannot validate
  #       it, so it is removed.
  #   no-tests     -- the test suite is not built or run in the cross sandbox
  #       (the VM checks below exercise the result instead).
  #   no-secure-memory -- crypto/mem_sec.c calls mmap/mprotect/mlock/madvise/
  #       munmap for its mlocked, non-swappable "secure arena"; those are
  #       unavailable here (the mman prototypes are not even visible, so it
  #       fails to compile). Disabling it makes CRYPTO_secure_malloc fall back
  #       to the ordinary heap. No real guarantee is lost: wasm has no mmap,
  #       mlock or swap for the arena to have protected in the first place.
  #   no-apps is deliberately NOT set: the `openssl` CLI is useful userland
  #       and is installed to $out/bin.
  #
  # -DHAVE_FORK=0 compiles out the apps' HTTP/OCSP responder daemon, the only
  # code that calls fork() (absent on this platform); the CLI subcommands we
  # care about do not use it.
  configurePhase = ''
    runHook preConfigure
    perl ./Configure linux-generic32 \
      "CC=$CC" "AR=$AR" "RANLIB=$RANLIB" \
      -DHAVE_FORK=0 \
      --prefix=/ \
      --libdir=lib \
      --openssldir=/etc/ssl \
      no-shared \
      no-dso \
      no-dynamic-engine \
      no-async \
      no-afalgeng \
      no-secure-memory \
      no-tests
    runHook postConfigure
  '';

  enableParallelBuilding = true;

  # install_sw installs the static libs, headers and the openssl binary;
  # install_ssldirs adds the default openssl.cnf the CLI loads (req/genpkey
  # want it present). Documentation targets are skipped: they run pod2man,
  # which is build-host work we do not need for the port.
  installTargets = [
    "install_sw"
    "install_ssldirs"
  ];
  installFlags = [ "DESTDIR=$(out)" ];

  postInstall = ''
    # X509_get_default_cert_file() resolves this guest path. Keep the bundle
    # beside openssl.cnf in the staged OPENSSLDIR so CLI and library
    # consumers can verify with their defaults after the slice is overlaid.
    cp ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt $out/etc/ssl/cert.pem
  '';

  passthru.checks =
    let
      # A C program linked against the installed libssl.a/libcrypto.a that runs
      # a full TLS handshake in memory (see handshake.c). Proves the libraries
      # are usable by a consumer, not just the bundled CLI.
      handshake = stdenv.mkDerivation {
        pname = "openssl-handshake";
        inherit (finalAttrs) version;
        dontUnpack = true;
        buildInputs = [ finalAttrs.finalPackage ];
        buildPhase = ''
          $CC -Wall -Wextra -Werror -o handshake ${./tests/handshake.c} \
            -lssl -lcrypto
        '';
        installPhase = ''
          mkdir -p $out/bin
          cp handshake $out/bin/
        '';
      };
    in
    {
      cli = vm-test.vmTest {
        name = "openssl-cli";
        initramfs = vm-test.mkInitramfs {
          name = "openssl-cli";
          init = ./tests/cli-test.sh;
          contents = [
            busybox
            finalAttrs.finalPackage
            handshake
          ];
        };
      };
    };
})
