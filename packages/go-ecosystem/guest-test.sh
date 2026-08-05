#!/bin/busybox sh

fail() {
  printf 'go ecosystem guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin
export HOME=/tmp/home
export TMPDIR=/tmp

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"
mkdir -p "$HOME" || fail "creating HOME failed"

for test_binary in /bin/*.test; do
  printf 'running %s\n' "$test_binary"
  test_skip='$^'
  case "$test_binary" in
  */age-age.test)
    # The examples open source-tree-relative fixtures which are intentionally
    # not part of this binary-only rootfs. Run every ordinary test instead.
    test_run='^Test'
    ;;
  */caddy-caddy.test)
    # Skip tests which need an IPv6 localhost resolver or source-tree-relative
    # fixtures. The file-server smoke below exercises Caddy's native bind path.
    test_run='^(TestUnsyncedConfigAccess|TestLoadConcurrent|TestAdminHandler.*|TestNewAdminHandlerRouterRegistration|TestAdminRouterProvisioning|TestAllowedOriginsUnixSocket|TestRemoteAdminAccessControlPathSegmentMatching|TestUnsyncedConfigAccessCanonicalArrayIndices|TestReplacer|TestReplacerSet|TestReplacerReplaceKnown|TestReplacerDelete|TestReplacerMap|TestReplacerNewWithoutFile)$'
    ;;
  */caddy-caddyconfig-caddyfile.test)
    test_run='^(TestFormatter|TestLexer|TestParseVariadic|TestAllTokens|TestEnvironmentReplacement|TestRejectsGlobalMatcher|TestRejectAnonymousImportBlock|TestAcceptSiteImportWithBraces|TestDispenser_.*)$'
    ;;
  */fzf-src.test)
    test_run='.'
    # TestHistory assumes an unprivileged user, subprocess output is not
    # available yet, and the randomized ANSI stress tests currently overflow
    # Go's wasm split stack on SMP guests.
    test_skip='^(TestHistory|TestReadFromCommand|TestNextAnsiEscapeSequence_Fuzz_)'
    ;;
  */x-crypto-ssh.test)
    test_run='Test(Buffer|ParseCert|ValidateCert|CheckCert|CertSign|MinPayload|WriteExtended|DefaultCiphers|PacketCiphers|CBCOracle|CVE|CompatibleAlgo|PickSignature|VerifyHostKeySignature|FindAgreedAlgorithms|KeyFormatAlgorithms|HandshakeErrorHandling|HandshakePendingPackets|PickIncompatible|ParseGSSAPI|BuildMIC|AutoPortListenBroken|ClientImplements|ClientDialContext|ReadVersion|ExchangeVersions|TransportMax)'
    ;;
  */x-net-proxy.test)
    test_run='Test(PerHost|FromEnvironment)'
    ;;
  */x-net-websocket.test)
    # httptest prefers IPv6 loopback, which this kernel does not enable. Keep
    # the framing and handshake coverage; Caddy's smoke covers server startup.
    test_run='^(TestSecWebSocketAccept|TestHybi.*|TestParseAuthority)$'
    ;;
  */x-sys-unix.test)
    # Exercise the supported file, descriptor, identity, and path syscall ABI.
    # mmap, vectored I/O, epoll, and several time syscalls are not implemented
    # or ABI-compatible yet and are deliberately outside this positive matrix.
    test_run='^Test(Env|Uname|StatFieldNames|Devices|Auxv|ErrnoSignalName|SignalNum|FcntlInt|FcntlFlock|Rlimit|SeekFailure|Dup|Getwd|Fstatat|Fchmodat|Mkdev|Pipe|Renameat|Faccessat|Openat2)$'
    ;;
  */x-term-x-term.test)
    # devpts is not mounted in this minimal initramfs.
    test_run='^TestIsTerminalTempFile$'
    ;;
  */yq-pkg-yqlib.test)
    test_run='.'
    # Scenario tests are generated from the documentation tree, which is not
    # present in this binary-only rootfs. Keep the parser, node, and encoders.
    test_skip='(Scenarios$|^TestRecipes$|^TestChangeOwner)'
    ;;
  *) test_run='.' ;;
  esac
  "$test_binary" -test.run="$test_run" -test.skip="$test_skip" -test.timeout=120s ||
    fail "$test_binary exited with $?"
done

printf 'smoking yq\n'
echo 'answer: 42' | yq -r '.answer' >/tmp/yq.out || fail "yq failed"
grep -qx 42 /tmp/yq.out || fail "yq returned the wrong value"

printf 'smoking age\n'
printf 'secret payload\n' >/tmp/age.plain
age-keygen -o /tmp/age.key >/tmp/age-keygen.log 2>&1 || fail "age-keygen failed"
age-keygen -y /tmp/age.key >/tmp/age.recipient || fail "age recipient extraction failed"
age -R /tmp/age.recipient -o /tmp/age.enc /tmp/age.plain || fail "age encryption failed"
age -d -i /tmp/age.key -o /tmp/age.out /tmp/age.enc || fail "age decryption failed"
grep -qx 'secret payload' /tmp/age.out || fail "age roundtrip changed the payload"

printf 'smoking restic\n'
restic version >/tmp/restic.out 2>&1 || fail "restic startup failed"
grep -q '^restic ' /tmp/restic.out || fail "restic returned an unexpected version"

printf 'smoking caddy\n'
mkdir -p /tmp/caddy-root
printf 'served by caddy\n' >/tmp/caddy-root/index.html
caddy file-server --listen :8080 --root /tmp/caddy-root >/tmp/caddy.log 2>&1 &
caddy_pid=$!
caddy_ready=false
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  if kill -0 "$caddy_pid" 2>/dev/null && grep -q 'Caddy serving static files' /tmp/caddy.log; then
    caddy_ready=true
    break
  fi
  sleep 1
done
kill "$caddy_pid" 2>/dev/null || true
wait "$caddy_pid" 2>/dev/null || true
[ "$caddy_ready" = true ] || fail "caddy did not start its file server: $(cat /tmp/caddy.log)"

printf 'smoking fzf\n'
echo 'alpha
needle
omega' | fzf --filter=need >/tmp/fzf.out || fail "fzf failed"
grep -qx needle /tmp/fzf.out || fail "fzf returned the wrong match"

echo "::vm-test::pass"
while :; do :; done
