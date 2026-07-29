#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# getrandom()/`/dev/urandom` back RAND_bytes and EC key generation.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
cd /tmp || fail "cd /tmp failed"

# (a) version string must name 3.5.7 (proves the binary is ours, not a stray).
ver=$(openssl version 2>&1) || fail "openssl version exited nonzero: $ver"
case "$ver" in
"OpenSSL 3.5.7"*) : ;;
*) fail "unexpected version: $ver" ;;
esac

# Runtime defaults must name guest paths and the fragment must carry both the
# configuration and trust bundle at those paths.
default_dir=$(openssl version -d 2>&1) || fail "openssl version -d failed: $default_dir"
[ "$default_dir" = 'OPENSSLDIR: "/etc/ssl"' ] || fail "wrong OPENSSLDIR: $default_dir"
[ -s /etc/ssl/openssl.cnf ] || fail "default openssl.cnf is missing"
[ -s /etc/ssl/cert.pem ] || fail "default CA bundle is missing"

# (b) SHA-256 known-answer: dgst of "abc" must equal the FIPS-180 vector. This
# runs the digest through the default provider end to end.
printf 'abc' >msg
want=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
got=$(openssl dgst -sha256 -r msg 2>/tmp/dgsterr) ||
  fail "dgst failed: $(cat /tmp/dgsterr)"
got=${got%% *}
[ "$got" = "$want" ] || fail "sha256 mismatch: got $got want $want"

# (c) entropy path: `rand -hex 16` must emit exactly 32 hex characters.
r=$(openssl rand -hex 16 2>/tmp/randerr) || fail "rand failed: $(cat /tmp/randerr)"
case "$r" in
*[!0-9a-f]*) fail "rand output not hex: $r" ;;
esac
[ "${#r}" -eq 32 ] || fail "rand -hex 16 length ${#r} != 32: $r"

# (d) end-to-end asymmetric path: generate an EC (P-256) key, self-sign an X.509
# cert, and verify it. This exercises bignum, EC point math, ASN.1 and X.509.
openssl ecparam -name prime256v1 -genkey -noout -out key.pem 2>/tmp/ecerr ||
  fail "ec keygen failed: $(cat /tmp/ecerr)"
openssl req -new -x509 -key key.pem -out cert.pem -days 1 \
  -subj /CN=wasm-openssl-selftest 2>/tmp/reqerr ||
  fail "self-signed cert failed: $(cat /tmp/reqerr)"
openssl verify -CAfile cert.pem cert.pem >/tmp/verout 2>&1 ||
  fail "verify failed: $(cat /tmp/verout)"
grep -q 'cert.pem: OK' /tmp/verout || fail "verify did not report OK: $(cat /tmp/verout)"

# (e) in-memory TLS handshake between an SSL_CTX pair over a BIO pair, driven by
# libssl+libcrypto directly. A stronger integration test than the CLI alone: it
# runs the full record/handshake state machine without any socket.
handshake >/tmp/hsout 2>&1 || fail "tls handshake test failed: $(cat /tmp/hsout)"
grep -q '^handshake ok$' /tmp/hsout || fail "handshake marker missing: $(cat /tmp/hsout)"

echo "::vm-test::pass"
while :; do :; done
