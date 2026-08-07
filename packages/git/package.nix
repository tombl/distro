{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://www.kernel.org/pub/software/scm/git/git-2.55.0.tar.xz";
    hash = "sha256-aTL1jVJ8xz4CMocAzzHaEepLgUO/7OXTb/Ao0GR5AVQ=";
  },
  busybox,
  ca-certificates,
  zlib,
  curl,
  openssl,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "git";
  version = "2.55.0";
  inherit src;

  # git creates every child through run-command.c:start_command(): a fork()
  # with the fd plumbing (dup2/close of the pipe ends, chdir for cmd->dir) done
  # in the window between fork() and exec(). wasm musl has no fork() (the symbol
  # does not exist), so that one site is rewritten to posix_spawn (clone+execve)
  # with the plumbing expressed as posix_spawn file actions and cmd->dir applied
  # via addchdir_np. Because posix_spawn runs no code in the child, the fork-era
  # notify-pipe / atfork signal-blocking machinery is deleted; posix_spawn
  # reports a failed dup2/chdir/exec (including the ENOEXEC "retry via sh"
  # fallback) through its own return value. This single conversion carries every
  # child git spawns: subcommands (repack -> pack-objects), hooks, the pager and
  # editor, textconv/external diff, and the pipe children behind upload-pack /
  # receive-pack, all of which route through start_command().
  #
  # The other raw fork() callers are not reached on this build: the async helper
  # (run-command.c) and the transport-helper data-copy loop use pthreads instead
  # of fork() unless NO_PTHREADS, and we build with threads; setup.c's
  # daemonize() (used by `gc --daemonize` and git-daemon) is compiled out by
  # NO_POSIX_GOODIES below, where it now fails loudly with ENOSYS rather than
  # backgrounding -- there is no fork to background with.
  patches = [ ./run-command-posix-spawn.patch ];

  # git's build runs shell and perl generators on the build host. The shell
  # ones use #!/bin/sh (present in the sandbox); patchShebangs rewrites any
  # #!/usr/bin/perl to the build perl, since the sandbox has no /usr/bin/env.
  # NO_PERL keeps the perl *programs* (git-svn, add--interactive, ...) out of
  # the build entirely, but a build-time generator can still be perl.
  nativeBuildInputs = [ pkgs.perl ];

  # POSIX timers work on the pinned kernel, including libcurl's progress timer;
  # the remote VM check exercises the transport without tolerating warnings.

  # zlib is mandatory: git deflates every object and pack with it. curl (built
  # against OpenSSL + zlib) provides the http/https smart transport used by
  # git-remote-http; OpenSSL supplies its TLS. All are static and picked up
  # through the cc-wrapper's -I/-L.
  buildInputs = [
    zlib
    curl
    openssl
  ];

  enableParallelBuilding = true;

  # git builds from a plain Makefile; autoconf is optional and its detection
  # would re-derive the platform truths we already know, so skip ./configure.
  dontConfigure = true;

  postPatch = ''
    patchShebangs --build .
  '';

  # CC/AR come from the wasm toolchain the stdenv exports; git's Makefile hard
  # assigns `CC = cc`, so pass CC/AR on the command line (makeFlagsArray is
  # expanded by the build shell) to win over that assignment. CURL_LDFLAGS pins
  # the static libcurl link line: a static libcurl cannot resolve its own TLS
  # and compression symbols, so its private deps (OpenSSL + zlib) must be named
  # on the link line after -lcurl. Setting CURL_LDFLAGS makes git use exactly
  # this line rather than deriving one from curl-config, keeping the static link
  # deterministic. It has spaces, so it must go through makeFlagsArray rather
  # than the makeFlags list (whose entries are split on whitespace); the -L
  # search paths for those libs come from buildInputs via the cc-wrapper.
  preBuild = ''
    makeFlagsArray+=(
      "CC=$CC" "AR=$AR"
      "CURL_LDFLAGS=-lcurl -lssl -lcrypto -lz"
    )
  '';

  # uname_S=Linux: the build host is Linux, so config.mak.uname already selects
  #   the Linux block (getrandom CSPRNG, clock_gettime, sysinfo, /proc). musl
  #   provides all of those symbols, so we keep the block and only override the
  #   platform-specific knobs below.
  # NO_MMAP: musl-wasm exposes no <sys/mman.h> functions (they sit behind
  #   #ifndef __wasm__), so git uses compat/mmap.c, which reads whole objects
  #   into memory instead of mapping them. Loud-failure-by-absence is avoided
  #   because git ships this fallback for exactly this case.
  # Unix sockets are enabled. In Git 2.55 credential-cache launches
  #   credential-cache--daemon directly through start_command(), so the
  #   posix_spawn conversion creates the long-lived daemon without any
  #   fork-without-exec step. The remote VM check covers a real cache round trip
  #   and proves the unsupported historical `--daemon` spelling fails cleanly.
  # NO_POSIX_GOODIES: removes the only remaining fork() reference (setup.c
  #   daemonize()); `gc --daemonize` and git-daemon then return ENOSYS.
  # NO_RUST: git 2.55 can build an experimental libgitcore.a with cargo. We have
  #   no Rust toolchain targeting wasm32-unknown-linux-musl in the stdenv, and
  #   the C implementation is complete on its own, so the Rust component is off.
  # NO_REGEX: musl's regex has no REG_STARTEND, which git requires (it matches
  #   over buffers that are not NUL-terminated). Build git's bundled regex
  #   (compat/regex/), which provides it.
  # NO_OPENSSL: disables Git's direct OpenSSL users (imap-send TLS and optional
  #   object-store hashes). HTTPS still uses OpenSSL through libcurl, whose
  #   private static dependencies are supplied in CURL_LDFLAGS above. Git's own
  #   SHA-1 (sha1dc/DC_SHA1) and SHA-256 (block) backends remain the defaults.
  # NO_{PERL,TCLTK,PYTHON,GETTEXT}: out of scope for this port.
  # curl is enabled (NO_CURL is *not* set): git-remote-http links libcurl for
  #   the smart http/https transport. CURL_CFLAGS/CURL_LDFLAGS are supplied
  #   explicitly (see preBuild) so the cross build never consults a host
  #   curl-config for link flags; CURL_CONFIG still points at the wasm curl's
  #   config script for git's version probe. NO_EXPAT: git-http-push (the dumb
  #   push protocol) needs expat, which we do not ship; the smart transport
  #   used by fetch/clone/ls-remote does not, so only http-push is dropped.
  # NO_INSTALL_HARDLINKS + INSTALL_SYMLINKS: install the ~100 git-<cmd> entries
  #   in libexec/git-core as symlinks to the git binary, not hardlinks. The
  #   initramfs builder copies contents with `cp -RP`, which turns each hardlink
  #   into a full copy of the (multi-MB wasm) binary but preserves symlinks; the
  #   symlink install keeps the image small.
  makeFlags = [
    "uname_S=Linux"
    "NO_RUST=YesPlease"
    "NO_MMAP=YesPlease"
    "NO_REGEX=YesPlease"
    "NO_POSIX_GOODIES=YesPlease"
    "NO_OPENSSL=YesPlease"
    "NO_PERL=YesPlease"
    "NO_TCLTK=YesPlease"
    "NO_PYTHON=YesPlease"
    "NO_GETTEXT=YesPlease"
    "NO_EXPAT=YesPlease"
    "CURL_CONFIG=${curl}/bin/curl-config"
    "CURL_CFLAGS=-I${curl}/include"
    "NO_INSTALL_HARDLINKS=YesPlease"
    "INSTALL_SYMLINKS=YesPlease"
    # config.mak.uname's Linux block sets LINK_FUZZ_PROGRAMS, which pulls the
    # oss-fuzz/fuzz-* targets into `make all`. Those link with libFuzzer and
    # -Wl,--allow-multiple-definition, an argument wasm-ld does not accept.
    # Override it empty (ifdef-false) so `all` skips the fuzzers.
    "LINK_FUZZ_PROGRAMS="
    # Compile guest paths into Git, then stage that FHS tree in the Nix output.
    # Using $out as prefix would make --exec-path and the template directory
    # point at a Nix store path that does not exist after the slice is overlaid.
    "prefix=/usr"
  ];

  # The default `install` target also runs `make all` dependencies with the
  # same flags via makeFlags. DESTDIR stages the compiled /usr layout under
  # $out without changing any of the paths Git uses in the guest.
  installTargets = [ "install" ];
  installFlags = [ "DESTDIR=${placeholder "out"}" ];

  # The CA bundle is a dependency-owned runtime file, not part of the payload:
  # installing it here would conflict with the ca-certificates package.
  passthru.apk.depends = [ "ca-certificates" ];

  passthru.checks =
    let
      check =
        name: init:
        vm-test.installedTest {
          name = "git-${name}";
          inherit init;
          # BusyBox supplies /bin/sh for Git's installed scripts and hooks,
          # cat (the pager), and the coreutils the test drives.
          contents = [
            busybox
            ca-certificates
            finalAttrs.finalPackage
          ];
        };
    in
    {
      workflow = check "workflow" ./workflow-test.sh;
      packing = check "packing" ./packing-test.sh;
      # Serve a real repository over guest loopback and fetch it through
      # git-remote-http/libcurl.
      remote = check "remote" ./remote-test.sh;
    };
})
