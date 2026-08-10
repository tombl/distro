#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export TERM=xterm
export HOME=/tmp

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

# Generate an ephemeral P-256 self-signed cert/key for the in-memory TLS test
# below, using the ported openssl CLI. Doing it in-guest means the validity
# window is anchored to the guest clock, so there is no build-host-vs-guest time
# skew that could make the cert "not yet valid" during the Python handshake.
# RAND_bytes/EC keygen read /dev/urandom from the runtime devtmpfs. The CLI must
# find openssl.cnf through its compiled OPENSSLDIR; no environment override is
# allowed here because this check validates the fragment's runtime defaults.
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/key.pem 2>/tmp/sslerr ||
  fail "ec keygen failed: $(cat /tmp/sslerr)"
openssl req -new -x509 -key /tmp/key.pem -out /tmp/cert.pem -days 3650 \
  -subj /CN=localhost -addext subjectAltName=DNS:localhost 2>/tmp/sslerr ||
  fail "self-signed cert failed: $(cat /tmp/sslerr)"
# Make the ephemeral endpoint trusted by the system bundle. The initramfs is
# writable, so the Python client can exercise create_default_context() without
# an explicit cafile while keeping its compiled path at /etc/ssl/cert.pem.
cat /tmp/cert.pem >>/etc/ssl/cert.pem || fail "extending default CA bundle failed"

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
assert "PYTHONHOME" not in os.environ
assert sys.prefix == "/usr", sys.prefix

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

# curses: the Python slice must carry the terminfo database itself.
import curses
curses.setupterm()
assert curses.tigetstr("clear"), "xterm terminfo entry was not loaded"

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

# OpenSSL and Python must expose guest paths, never the Nix staging store path.
paths = ssl.get_default_verify_paths()
assert paths.openssl_cafile == "/etc/ssl/cert.pem", paths
assert paths.openssl_capath == "/etc/ssl/certs", paths
assert paths.cafile == "/etc/ssl/cert.pem", paths
assert paths.capath == "/etc/ssl/certs", paths

# create_default_context() must load the bundle from that default path.
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

client_ctx = dctx
client_ctx.minimum_version = ssl.TLSVersion.TLSv1_3
client_ctx.maximum_version = ssl.TLSVersion.TLSv1_3
log("contexts built")

c_in, c_out = ssl.MemoryBIO(), ssl.MemoryBIO()
s_in, s_out = ssl.MemoryBIO(), ssl.MemoryBIO()
client = client_ctx.wrap_bio(c_in, c_out, server_hostname="localhost")
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

# PATH components from a str environment must be encoded for a bytes argv,
# matching os._execvpe and the fork path.
r = subprocess.run(
    [b"echo", b"bytes-path"],
    env={"PATH": "/bin:/usr/bin"},
    capture_output=True,
)
assert r.stdout.strip() == b"bytes-path", r

# cwd is implemented as a spawn file action and applies before PATH entries
# that are relative to the child working directory are resolved.
os.mkdir("/tmp/spawn-cwd")
r = subprocess.run(
    ["pwd"], cwd="/tmp/spawn-cwd", capture_output=True, text=True
)
assert r.stdout.strip() == "/tmp/spawn-cwd", repr(r.stdout)

# A failed PATH search must not fall back to spawning the bare name relative
# to cwd. Put an executable of that name in cwd to catch that exact regression.
missing = "python-definitely-missing"
with open("/tmp/spawn-cwd/" + missing, "w") as f:
    f.write("#!/bin/sh\necho wrongly-executed\n")
os.chmod("/tmp/spawn-cwd/" + missing, 0o755)
try:
    subprocess.run(
        [missing], cwd="/tmp/spawn-cwd", env={"PATH": "/bin:/usr/bin"}
    )
except FileNotFoundError:
    pass
else:
    raise AssertionError("missing PATH command did not raise FileNotFoundError")

# Session and process-group controls map directly to musl spawn attributes.
identity = "import os; print(os.getpid(), os.getsid(0), os.getpgrp())"
r = subprocess.run(
    [sys.executable, "-c", identity],
    start_new_session=True,
    capture_output=True,
    text=True,
)
pid, sid, _ = map(int, r.stdout.split())
assert sid == pid, (pid, sid)
r = subprocess.run(
    [sys.executable, "-c", identity],
    process_group=0,
    capture_output=True,
    text=True,
)
pid, _, pgrp = map(int, r.stdout.split())
assert pgrp == pid, (pid, pgrp)

# close_fds=True is the default. Use a high inheritable descriptor so normal
# child startup cannot accidentally reuse its number and hide a leak.
import fcntl
leak_fd = fcntl.fcntl(1, fcntl.F_DUPFD, 50)
os.set_inheritable(leak_fd, True)
try:
    r = subprocess.run(["sh", "-c", f"test ! -e /proc/self/fd/{leak_fd}"])
    assert r.returncode == 0, "inheritable fd leaked through close_fds=True"
finally:
    os.close(leak_fd)

# pass_fds clears FD_CLOEXEC for exactly the requested descriptors. This is the
# same posix_spawn file action used by multiprocessing's control pipes.
pass_read, pass_write = os.pipe()
try:
    os.write(pass_write, b"passed")
    r = subprocess.run(
        [
            sys.executable,
            "-c",
            "import os, sys; print(os.read(int(sys.argv[1]), 6).decode())",
            str(pass_read),
        ],
        pass_fds=(pass_read,),
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0 and r.stdout.strip() == "passed", r
finally:
    os.close(pass_read)
    os.close(pass_write)

# Options with no musl posix_spawn equivalent must fail explicitly.
unsupported = (
    ("preexec_fn", {"preexec_fn": lambda: None}),
    ("group", {"group": 0}),
    ("extra_groups", {"extra_groups": []}),
    ("user", {"user": 0}),
    ("umask", {"umask": 0}),
)
for option, kwargs in unsupported:
    try:
        subprocess.run(["true"], **kwargs)
    except NotImplementedError as exc:
        assert option in str(exc), (option, str(exc))
    else:
        raise AssertionError(option + " was silently ignored")

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

# The kernel-backed sem_open family enables CPython's _multiprocessing SemLock.
# Prove the extension against a fresh exec'd interpreter rather than only
# checking that it imports: the child reopens the parent's name and wakes it.
import _multiprocessing
assert _multiprocessing.flags["HAVE_SEM_OPEN"] == 1
assert hasattr(_multiprocessing, "sem_unlink")

semlock_name = f"/python-semlock-{os.getpid()}"
semlock = _multiprocessing.SemLock(1, 0, 3, semlock_name, False)
semlock_child = (
    "import _multiprocessing, sys; "
    "s = _multiprocessing.SemLock._rebuild(0, 1, 3, sys.argv[1]); "
    "s.release()"
)
try:
    child = subprocess.Popen([sys.executable, "-c", semlock_child, semlock_name])
    assert semlock.acquire(timeout=2), "exec'd child did not post named semaphore"
    assert semlock._get_value() == 0
    assert child.wait(timeout=2) == 0
finally:
    _multiprocessing.sem_unlink(semlock_name)

# The public synchronization wrappers do not require mmap or fork when used by
# threads in one interpreter. Exercise every non-mmap-backed primitive,
# including timed waits, sem_getvalue-backed bounds, and condition handoff.
import multiprocessing as mp
import threading
import time

sem = mp.Semaphore(0)
wakes = []

def wait_for_sem():
    wakes.append(sem.acquire(timeout=2))

waiter = threading.Thread(target=wait_for_sem)
waiter.start()
time.sleep(0.02)
assert wakes == []
sem.release()
waiter.join(2)
assert not waiter.is_alive()
assert wakes == [True]
assert sem.get_value() == 0

bounded = mp.BoundedSemaphore(1)
assert bounded.acquire(False)
bounded.release()
try:
    bounded.release()
except ValueError:
    pass
else:
    raise AssertionError("BoundedSemaphore allowed an overflowing release")

lock = mp.Lock()
assert lock.acquire(False)
assert not lock.acquire(False)
lock.release()

rlock = mp.RLock()
with rlock:
    with rlock:
        pass

condition = mp.Condition()
condition_ready = threading.Event()
condition_state = {"released": False, "observed": False}

def wait_for_condition():
    with condition:
        condition_ready.set()
        condition_state["observed"] = condition.wait_for(
            lambda: condition_state["released"], timeout=2
        )

waiter = threading.Thread(target=wait_for_condition)
waiter.start()
assert condition_ready.wait(2)
with condition:
    condition_state["released"] = True
    condition.notify()
waiter.join(2)
assert not waiter.is_alive()
assert condition_state["observed"]

event = mp.Event()
assert not event.wait(0.01)
event.set()
assert event.is_set() and event.wait(0.1)
event.clear()
assert not event.is_set()

print("PYOK")
PYEOF

cat >/tmp/multiprocessing-test.py <<'PYEOF'
import concurrent.futures
import fcntl
import multiprocessing as mp
import os
import sys


def lock_child(lock, result, leaked_path):
    with lock:
        leaked = False
        for name in os.listdir("/proc/self/fd"):
            try:
                leaked |= os.readlink(f"/proc/self/fd/{name}") == leaked_path
            except FileNotFoundError:
                pass
        result.send((os.getpid(), os.getppid(), leaked))
        result.close()


def queue_child(queue):
    queue.put((os.getpid(), "queue"))


def square(value):
    return value * value


def manager_child(shared):
    shared["pid"] = os.getpid()


def nested_leaf(result):
    result.send(os.getpid())
    result.close()


def nested_child(result):
    recv, send = mp.Pipe(duplex=False)
    child = mp.Process(target=nested_leaf, args=(send,))
    child.start()
    send.close()
    grandchild_pid = recv.recv()
    child.join(5)
    result.send((os.getpid(), grandchild_pid, child.exitcode))
    result.close()


def noop():
    pass


if __name__ == "__main__":
    assert mp.get_all_start_methods() == ["spawn"]
    assert mp.get_start_method() == "spawn"
    for unsupported in ("fork", "forkserver"):
        try:
            mp.get_context(unsupported)
        except ValueError:
            pass
        else:
            raise AssertionError(f"advertised unsupported {unsupported} context")

    # A real Process gets a distinct PID and blocks on a named Lock rebuilt in
    # the fresh interpreter. Only multiprocessing's control fds may survive.
    leaked_path = "/tmp/multiprocessing-unpassed-fd"
    base_fd = os.open(leaked_path, os.O_CREAT | os.O_RDWR, 0o600)
    leak_fd = fcntl.fcntl(base_fd, fcntl.F_DUPFD, 50)
    os.close(base_fd)
    os.set_inheritable(leak_fd, True)
    recv, send = mp.Pipe(duplex=False)
    lock = mp.Lock()
    lock.acquire()
    child = mp.Process(
        target=lock_child,
        args=(lock, send, leaked_path),
    )
    try:
        child.start()
        send.close()
        assert not recv.poll(0.05), "spawned child bypassed the shared lock"
        lock.release()
        child_pid, child_parent_pid, leaked = recv.recv()
        child.join(5)
        assert child.exitcode == 0, child.exitcode
        assert child_pid != os.getpid()
        assert child_parent_pid == os.getpid()
        assert not leaked, "unpassed inheritable fd leaked into spawned child"
    finally:
        if child.is_alive():
            child.kill()
            child.join()
        if lock.acquire(False):
            lock.release()
        recv.close()
        os.close(leak_fd)

    # Queue, Pool, and ProcessPoolExecutor all depend on the same spawn fd
    # handoff plus cross-process SemLock reconstruction.
    queue = mp.Queue()
    child = mp.Process(target=queue_child, args=(queue,))
    child.start()
    queue_pid, payload = queue.get(timeout=5)
    child.join(5)
    assert child.exitcode == 0 and queue_pid != os.getpid() and payload == "queue"
    queue.close()
    queue.join_thread()

    simple_queue = mp.SimpleQueue()
    child = mp.Process(target=queue_child, args=(simple_queue,))
    child.start()
    child.join(5)
    assert child.exitcode == 0
    simple_pid, payload = simple_queue.get()
    assert simple_pid != os.getpid() and payload == "queue"
    simple_queue.close()

    joinable_queue = mp.JoinableQueue()
    child = mp.Process(target=queue_child, args=(joinable_queue,))
    child.start()
    joinable_pid, payload = joinable_queue.get(timeout=5)
    joinable_queue.task_done()
    joinable_queue.join()
    child.join(5)
    assert child.exitcode == 0
    assert joinable_pid != os.getpid() and payload == "queue"
    joinable_queue.close()
    joinable_queue.join_thread()

    with mp.Pool(2) as pool:
        assert pool.map_async(square, range(6)).get(5) == [0, 1, 4, 9, 16, 25]

    with concurrent.futures.ProcessPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(square, value) for value in range(6)]
        assert [future.result(5) for future in futures] == [0, 1, 4, 9, 16, 25]

    with mp.Manager() as manager:
        shared = manager.dict()
        child = mp.Process(target=manager_child, args=(shared,))
        child.start()
        child.join(5)
        assert child.exitcode == 0 and shared["pid"] != os.getpid()

    # Spawn remains composable from inside a spawned interpreter and reuses the
    # resource tracker descriptor across both generations.
    recv, send = mp.Pipe(duplex=False)
    child = mp.Process(target=nested_child, args=(send,))
    child.start()
    send.close()
    child_pid, grandchild_pid, grandchild_exitcode = recv.recv()
    child.join(5)
    assert child.exitcode == 0 and grandchild_exitcode == 0
    assert len({os.getpid(), child_pid, grandchild_pid}) == 3
    recv.close()

    # musl reports exec failure synchronously from posix_spawn: start raises
    # instead of returning a doomed child or leaving a zombie behind.
    mp.set_executable("/python-does-not-exist")
    child = mp.Process(target=noop)
    try:
        child.start()
    except FileNotFoundError:
        pass
    else:
        child.kill()
        child.join()
        raise AssertionError("missing multiprocessing executable did not fail")
    finally:
        mp.set_executable(sys.executable)

    print("MPOK")
PYEOF

python3 /tmp/test.py >/tmp/out 2>/tmp/err ||
  fail "python test failed [progress: $(tr '\n' '|' </tmp/progress)] out=$(tr '\n' '|' </tmp/out) err=$(tr '\n' '|' </tmp/err)"
grep -qx PYOK /tmp/out ||
  fail "python test did not reach PYOK [progress: $(tr '\n' '|' </tmp/progress)] out=$(tr '\n' '|' </tmp/out) err=$(tr '\n' '|' </tmp/err)"

python3 /tmp/multiprocessing-test.py >/tmp/mpout 2>/tmp/mperr ||
  fail "multiprocessing test failed out=$(tr '\n' '|' </tmp/mpout) err=$(tr '\n' '|' </tmp/mperr)"
grep -qx MPOK /tmp/mpout ||
  fail "multiprocessing test did not reach MPOK out=$(tr '\n' '|' </tmp/mpout) err=$(tr '\n' '|' </tmp/mperr)"
test ! -s /tmp/mperr ||
  fail "multiprocessing test emitted stderr: $(tr '\n' '|' </tmp/mperr)"

echo "::vm-test::pass"
while :; do :; done
