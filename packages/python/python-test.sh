#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export TERM=xterm
export TERMINFO=/share/terminfo
export HOME=/tmp
# The interpreter was configured with a /nix/store prefix that does not exist in
# the guest; the initramfs lays the install out at /. Point PYTHONHOME at / so
# the stdlib is found at /lib/python3.13 without relying on getpath heuristics.
export PYTHONHOME=/

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

# Generate an ephemeral P-256 self-signed cert/key for the in-memory TLS test
# below, using the ported openssl CLI. Doing it in-guest means the validity
# window is anchored to the guest clock, so there is no build-host-vs-guest time
# skew that could make the cert "not yet valid" during the Python handshake.
# RAND_bytes/EC keygen read /dev/urandom (devtmpfs, mounted above); the CLI reads
# openssl.cnf via OPENSSL_CONF.
export OPENSSL_CONF=/etc/ssl/openssl.cnf
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/key.pem 2>/tmp/sslerr ||
  fail "ec keygen failed: $(cat /tmp/sslerr)"
openssl req -new -x509 -key /tmp/key.pem -out /tmp/cert.pem -days 3650 \
  -subj /CN=localhost 2>/tmp/sslerr ||
  fail "self-signed cert failed: $(cat /tmp/sslerr)"

# The interpreter is wasm and cannot run on the build host, so every assertion
# lives here and runs in the guest. Any failure exits non-zero with a traceback.
cat >/tmp/test.py <<'PYEOF'
import sys, os, json, subprocess

# Progress breadcrumb: open/append/close per call so the last completed step is
# always durably on the guest tmpfs even if the interpreter hard-traps (a wasm
# trap leaves no Python traceback and can lose buffered stdio). The shell prints
# this file when the test aborts.
def log(m):
    with open("/tmp/progress", "a") as f:
        f.write(m + "\n")

expected = "3.13.14"
assert sys.version.startswith(expected), sys.version
assert sys.version_info[:3] == (3, 13, 14), sys.version_info

# arithmetic + string evaluation
assert eval("6 * 7") == 42
assert eval("'ab' * 3 + 'c'") == "abababc"
assert sum(range(101)) == 5050

# json round-trip
obj = {"n": 42, "xs": [1, 2, 3], "s": "héllo", "nested": {"ok": True}}
assert json.loads(json.dumps(obj)) == obj

# file I/O
p = "/tmp/io.txt"
payload = "line1\nline2\n"
with open(p, "w") as f:
    f.write(payload)
with open(p) as f:
    assert f.read() == payload

# compression batteries: compress + decompress round-trip
data = b"the quick brown fox" * 100
import zlib
assert zlib.decompress(zlib.compress(data)) == data
import bz2
assert bz2.decompress(bz2.compress(data)) == data
import lzma
assert lzma.decompress(lzma.compress(data)) == data

# sqlite3: an actual :memory: query
import sqlite3
con = sqlite3.connect(":memory:")
con.execute("CREATE TABLE t(a, b)")
con.execute("INSERT INTO t VALUES (6, 7)")
(product,) = con.execute("SELECT a * b FROM t").fetchone()
assert product == 42, product
con.close()

# curses: import only (no real terminal in the guest)
import curses  # noqa: F401

# hashlib: known-answer vectors must hold regardless of which backend serves
# them. With _hashlib (OpenSSL) now built, hashlib routes the "guaranteed"
# algorithms (md5/sha1/sha2/sha3) through OpenSSL when available and falls back
# to the builtin HACL* modules otherwise; blake2 always comes from the builtin
# _blake2 (OpenSSL's BLAKE2 lacks the keyed/variable-length API hashlib exposes).
# We assert correctness hard and report the backend module for each digest.
import hashlib

def _backend(ctor, *args):
    # OpenSSL-backed digests are _hashlib.HASH/HASHXOF; builtins live in
    # _sha2/_sha3/_blake2/_md5. __module__ of the object's type names it.
    return type(ctor(*args)).__module__

assert hashlib.sha256(b"abc").hexdigest() == (
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
)
# SHA3-256("abc") — FIPS-202 vector.
assert hashlib.sha3_256(b"abc").hexdigest() == (
    "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532"
)
# BLAKE2b-512("abc") and BLAKE2s-256("abc") — RFC 7693 vectors.
assert hashlib.blake2b(b"abc").hexdigest() == (
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1"
    "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"
)
assert hashlib.blake2s(b"abc").hexdigest() == (
    "508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982"
)
# keyed BLAKE2 (proves the builtin _blake2's extended API, absent from OpenSSL).
assert hashlib.blake2b(b"abc", key=b"secret").digest() != hashlib.blake2b(b"abc").digest()
# The OpenSSL build must actually be serving the SHA-2/SHA-3 family.
sha256_backend = _backend(hashlib.sha256)
sha3_backend = _backend(hashlib.sha3_256)
blake2_backend = _backend(hashlib.blake2b)
log("hashlib-backends sha256=%s sha3_256=%s blake2b=%s"
    % (sha256_backend, sha3_backend, blake2_backend))
assert sha256_backend == "_hashlib", sha256_backend
assert sha3_backend == "_hashlib", sha3_backend
assert blake2_backend == "_blake2", blake2_backend

# --- ssl: module present and linked against the ported OpenSSL 3.5.7 ---
log("import ssl")
import ssl
log("ssl imported: " + ssl.OPENSSL_VERSION)
# OPENSSL_VERSION carries the build date too ("OpenSSL 3.5.7 9 Jun 2026"), so
# match the prefix; OPENSSL_VERSION_INFO is the structured (major,minor,patch).
assert ssl.OPENSSL_VERSION.startswith("OpenSSL 3.5.7"), ssl.OPENSSL_VERSION
# OPENSSL_VERSION_INFO is (major, minor, fix, patch, status); 3.5.7 -> patch 7.
assert ssl.OPENSSL_VERSION_INFO[:2] == (3, 5), ssl.OPENSSL_VERSION_INFO
assert ssl.OPENSSL_VERSION_INFO[3] == 7, ssl.OPENSSL_VERSION_INFO

# create_default_context() must construct even with no CA bundle in the guest.
# It defaults to CERT_REQUIRED + check_hostname; loading system CAs finds none
# here, which is fine — construction and configuration are what we assert.
dctx = ssl.create_default_context()
assert dctx.verify_mode == ssl.CERT_REQUIRED, dctx.verify_mode
assert dctx.check_hostname is True
log("create_default_context ok")

# Full in-memory TLS 1.3 handshake over MemoryBIO + SSLObject (no sockets:
# AF_UNIX/socketpair are unavailable). The server presents the self-signed cert
# generated above; the client trusts it as a CA and verifies the chain. App data
# is round-tripped in both directions through the encrypted channel.
with open("/tmp/cert.pem") as f:
    cert_pem = f.read()
assert "BEGIN CERTIFICATE" in cert_pem, "cert fixture missing"

server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
server_ctx.load_cert_chain("/tmp/cert.pem", "/tmp/key.pem")
server_ctx.minimum_version = ssl.TLSVersion.TLSv1_3
server_ctx.maximum_version = ssl.TLSVersion.TLSv1_3

client_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
client_ctx.load_verify_locations("/tmp/cert.pem")  # trust our self-signed cert
client_ctx.check_hostname = False  # cert has no SAN; verify the chain, not name
client_ctx.verify_mode = ssl.CERT_REQUIRED
client_ctx.minimum_version = ssl.TLSVersion.TLSv1_3
client_ctx.maximum_version = ssl.TLSVersion.TLSv1_3
log("contexts built")

c_in, c_out = ssl.MemoryBIO(), ssl.MemoryBIO()
s_in, s_out = ssl.MemoryBIO(), ssl.MemoryBIO()
client = client_ctx.wrap_bio(c_in, c_out)
server = server_ctx.wrap_bio(s_in, s_out, server_side=True)
log("wrap_bio ok")

def _pump():
    # shuttle any pending ciphertext between the two BIO pairs
    d = c_out.read()
    if d:
        s_in.write(d)
    d = s_out.read()
    if d:
        c_in.write(d)

# drive the handshake to completion on both ends
for _round in range(50):
    done = 0
    for endpoint in (client, server):
        try:
            endpoint.do_handshake()
            done += 1
        except ssl.SSLWantReadError:
            pass
    _pump()
    log("handshake round %d done=%d" % (_round, done))
    if done == 2:
        break
else:
    raise AssertionError("TLS handshake did not converge")

assert client.version() == "TLSv1.3", client.version()
assert server.version() == "TLSv1.3", server.version()
log("handshake complete " + client.version())

def _send(src, src_out, dst, dst_in, payload):
    src.write(payload)
    while True:
        d = src_out.read()
        if not d:
            break
        dst_in.write(d)
    return dst.read(len(payload))

msg_c2s = b"ping from client " * 8
assert _send(client, c_out, server, s_in, msg_c2s) == msg_c2s
msg_s2c = b"pong from server " * 8
assert _send(server, s_out, client, c_in, msg_s2c) == msg_s2c
log("tls-handshake %s %s" % (client.version(), client.cipher()[0]))
print("tls-handshake", client.version(), client.cipher()[0])

# subprocess.run must launch a child through os.posix_spawn (no fork()).
assert not subprocess._HAVE_FORK_EXEC, "expected _posixsubprocess to be absent"
r = subprocess.run(["echo", "hi"], capture_output=True, text=True)
assert r.returncode == 0, r
assert r.stdout.strip() == "hi", repr(r.stdout)

# fork() must fail cleanly rather than crash the runtime. musl omits the fork
# symbol on wasm, so CPython does not expose os.fork at all (as on Windows/WASI);
# a missing attribute is the cleanest possible failure. If some future build
# does expose it, calling it must still raise OSError rather than crash.
if hasattr(os, "fork"):
    try:
        os.fork()
    except OSError:
        pass
    else:
        raise AssertionError("os.fork() unexpectedly succeeded")
else:
    assert not hasattr(os, "forkpty")  # sanity: the whole fork family is absent

print("PYOK")
PYEOF

python3.13 /tmp/test.py >/tmp/out 2>/tmp/err ||
  fail "python test failed [progress: $(tr '\n' '|' </tmp/progress)] out=$(tr '\n' '|' </tmp/out) err=$(tr '\n' '|' </tmp/err)"
grep -qx PYOK /tmp/out ||
  fail "python test did not reach PYOK [progress: $(tr '\n' '|' </tmp/progress)] out=$(tr '\n' '|' </tmp/out) err=$(tr '\n' '|' </tmp/err)"

echo "::vm-test::pass"
while :; do :; done
