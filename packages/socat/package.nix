{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "http://www.dest-unreach.org/socat/download/socat-1.8.1.3.tar.gz";
    hash = "sha256-uLBS4xy1wCHyD9SOicF6yz3Xvq7avMP9NUWKNLQ8qnM=";
  },
  openssl,
  readline,
  ncurses,
  vm-test,
  busybox,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "socat";
  version = "1.8.1.3";
  inherit src;

  buildInputs = [
    openssl
    # The READLINE address; readline links against ncurses here.
    readline
    ncurses
  ];

  # wasm musl has no fork(). Every socat child is created through the single
  # xio_fork() choke point, and this patch reexpresses the ones that can be
  # expressed -- EXEC, SYSTEM and SHELL -- on top of callback clone(), which
  # gives the child a private address space but a fresh stack. The "fork"
  # address option cannot be: its child resumes the parent's call chain. See
  # the patch header.
  patches = [ ./wasm-clone-processes.patch ];

  # yodl2man renders doc/socat.1, which the install target depends on.
  nativeBuildInputs = [ pkgs.yodl ];

  # Static-only, with the two libraries this scope ships. libwrap is off
  # explicitly so a cross configure cannot latch onto a build-platform copy;
  # the address families stay at upstream's defaults, so an address the kernel
  # does not implement fails at socket() exactly as it would on any other Linux
  # without that support, rather than vanishing from socat -V.
  configureFlags = [
    "--enable-openssl"
    "--enable-openssl-base=${openssl}"
    "--enable-readline"
    "--disable-libwrap"
  ];

  enableParallelBuilding = true;

  postInstall = ''
    # socat-chain.sh, socat-mux.sh and socat-broker.sh are "#!/usr/bin/env bash"
    # wrappers whose interpreter this distro does not have, and each drives
    # socat through the unsupported "fork" option. Ship only the programs.
    rm -f $out/bin/socat-chain.sh $out/bin/socat-mux.sh $out/bin/socat-broker.sh
  '';

  passthru.checks = {
    addresses = vm-test.vmTest {
      name = "socat-addresses";
      initramfs = vm-test.mkInitramfs {
        name = "socat-addresses";
        init = ./tests/addresses-test.sh;
        contents = [
          # busybox supplies /bin/sh, the coreutils the test drives, and the
          # programs socat's EXEC and SYSTEM addresses run.
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
