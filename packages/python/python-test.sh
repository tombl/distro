#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
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

# The interpreter is wasm and cannot run on the build host, so every assertion
# lives here and runs in the guest. Any failure exits non-zero with a traceback.
cat >/tmp/test.py <<'PYEOF'
import sys, os, json, subprocess

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

# hashlib works through the builtin HACL backend (no OpenSSL)
import hashlib
assert hashlib.sha256(b"abc").hexdigest() == (
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
)

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
  fail "python test failed: $(cat /tmp/out /tmp/err)"
grep -qx PYOK /tmp/out || fail "python test did not reach PYOK: $(cat /tmp/out /tmp/err)"

echo "::vm-test::pass"
while :; do :; done
