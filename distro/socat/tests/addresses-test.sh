#!/bin/busybox sh
# End-to-end socat check. It exercises the address types this port has to get
# right: plain file and socket relays, which need no child process, and the
# EXEC/SYSTEM/SHELL family, whose children are created with clone() rather than
# fork() on this platform. The VSOCK addresses run against the vm-test runner
# on the host, in both directions, and over the guest's own loopback transport.
# It also pins the diagnostic for the "fork" address option, which this
# platform cannot provide.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /dev/pts || fail "creating /dev/pts failed"
mount -t devpts devpts /dev/pts || fail "mounting devpts failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

# The socket relays below all run over loopback, which is down at boot.
ip link set lo up || fail "'ip link set lo up' failed"

# Spin until the kernel reports a listening TCP socket on the given port, so a
# client never races ahead of its server. $1 is the port in the hex form
# /proc/net/tcp prints, $2 the pid that must stay alive while we wait.
await_listen() {
  attempts=0
  while kill -0 "$2" 2>/dev/null; do
    if awk -v p=":$1\$" '$2 ~ p && $4 == "0A" { found = 1 } END { exit !found }' \
      /proc/net/tcp; then
      return 0
    fi
    attempts=$((attempts + 1))
    [ "$attempts" -lt 100000 ] || fail "no listener appeared on port $1"
  done
  fail "server on port $1 exited before it listened"
}

# A payload large enough to cross socat's transfer buffer several times.
: >/tmp/data
i=0
while [ "$i" -lt 400 ]; do
  printf 'line %d the quick brown fox jumps over 0123456789\n' "$i" >>/tmp/data
  i=$((i + 1))
done

# (1) -V must report the build's feature set, including the two libraries this
# package links and the address groups the checks below depend on.
socat -V >/tmp/version 2>&1 || fail "socat -V failed: $(cat /tmp/version)"
grep -q 'socat version 1.8.1.3' /tmp/version ||
  fail "unexpected version banner: $(head -n1 /tmp/version)"
for feature in WITH_OPENSSL WITH_READLINE WITH_EXEC WITH_SYSTEM WITH_SHELL \
  WITH_PTY WITH_LISTEN WITH_UNIX WITH_IP4 WITH_TCP WITH_UDP WITH_VSOCK; do
  grep -q "^ *#define $feature 1" /tmp/version ||
    fail "$feature not enabled in this build: $(grep "$feature" /tmp/version)"
done
echo "socat -V feature set verified"

# (2) File copy: no child process, no socket, just the transfer loop.
socat -u FILE:/tmp/data CREATE:/tmp/file.out 2>/tmp/file.err ||
  fail "FILE -> CREATE failed: $(cat /tmp/file.err)"
cmp /tmp/data /tmp/file.out || fail "FILE -> CREATE content mismatch"
echo "file relay verified"

# (3) TCP loopback round trip, one connection, no "fork".
socat -u TCP4-LISTEN:9000,reuseaddr CREATE:/tmp/tcp.out 2>/tmp/tcp.err &
tcp_pid=$!
await_listen 2328 "$tcp_pid"
socat -u FILE:/tmp/data TCP4:127.0.0.1:9000 2>/tmp/tcpclient.err ||
  fail "TCP client failed: $(cat /tmp/tcpclient.err)"
wait "$tcp_pid" || fail "TCP server failed: $(cat /tmp/tcp.err)"
cmp /tmp/data /tmp/tcp.out || fail "TCP round trip content mismatch"
echo "TCP relay verified"

# (4) The same over an AF_UNIX stream socket.
rm -f /tmp/relay.sock
socat -u UNIX-LISTEN:/tmp/relay.sock CREATE:/tmp/unix.out 2>/tmp/unix.err &
unix_pid=$!
attempts=0
while [ ! -S /tmp/relay.sock ]; do
  kill -0 "$unix_pid" 2>/dev/null || fail "UNIX server exited: $(cat /tmp/unix.err)"
  attempts=$((attempts + 1))
  [ "$attempts" -lt 100000 ] || fail "UNIX-LISTEN never created its socket"
done
socat -u FILE:/tmp/data UNIX-CONNECT:/tmp/relay.sock 2>/tmp/unixclient.err ||
  fail "UNIX client failed: $(cat /tmp/unixclient.err)"
wait "$unix_pid" || fail "UNIX server failed: $(cat /tmp/unix.err)"
cmp /tmp/data /tmp/unix.out || fail "UNIX round trip content mismatch"
echo "UNIX relay verified"

# (5) EXEC over the default socketpair. This is the clone() path: the child
# finishes _xioopen_foxec()'s descriptor setup on its own stack and execs.
socat -u "EXEC:/bin/echo exec-marker" - >/tmp/exec.out 2>/tmp/exec.err ||
  fail "EXEC failed: $(cat /tmp/exec.err)"
[ "$(cat /tmp/exec.out)" = "exec-marker" ] ||
  fail "EXEC output mismatch: [$(cat /tmp/exec.out)]"
echo "EXEC (socketpair) verified"

# (6) EXEC over pipes rather than a socketpair.
socat -u "EXEC:/bin/echo pipes-marker,pipes" - >/tmp/pipes.out 2>/tmp/pipes.err ||
  fail "EXEC,pipes failed: $(cat /tmp/pipes.err)"
[ "$(cat /tmp/pipes.out)" = "pipes-marker" ] ||
  fail "EXEC,pipes output mismatch: [$(cat /tmp/pipes.out)]"
echo "EXEC (pipes) verified"

# (7) EXEC on a pty: the child must open the slave, make it its controlling
# terminal via setsid+ctty, and run with that tty on both ends of its stdio.
# The child is a script rather than an inline command line so that EXEC's own
# lexer, not this shell's quoting, decides where the arguments end.
cat >/tmp/pty-child.sh <<'CHILD'
#!/bin/busybox sh
tty
[ -t 0 ] && echo TTY0=yes || echo TTY0=no
[ -t 1 ] && echo TTY1=yes || echo TTY1=no
CHILD
chmod +x /tmp/pty-child.sh || fail "chmod pty-child.sh failed"
# ignoreeof keeps socat from tearing the pty down when its own stdin, which the
# harness gives no input, reports EOF straight away.
socat STDIO,ignoreeof "EXEC:/tmp/pty-child.sh,pty,setsid,ctty" \
  </dev/null >/tmp/pty.out 2>/tmp/pty.err ||
  fail "EXEC,pty failed: $(cat /tmp/pty.err)"
# A pty's line discipline turns each LF into CRLF on the way out.
tr -d '\r' </tmp/pty.out >/tmp/pty.clean
pty_name=$(sed -n 1p /tmp/pty.clean)
case $pty_name in
/dev/pts/*) : ;;
*) fail "EXEC,pty child got no controlling tty: $(cat /tmp/pty.clean)" ;;
esac
grep -qx 'TTY0=yes' /tmp/pty.clean ||
  fail "EXEC,pty child had no tty on stdin: $(cat /tmp/pty.clean)"
grep -qx 'TTY1=yes' /tmp/pty.clean ||
  fail "EXEC,pty child had no tty on stdout: $(cat /tmp/pty.clean)"
echo "EXEC (pty) verified on $pty_name"

# (8) SYSTEM runs its argument through /bin/sh.
socat -u "SYSTEM:echo system-marker" - >/tmp/system.out 2>/tmp/system.err ||
  fail "SYSTEM failed: $(cat /tmp/system.err)"
[ "$(cat /tmp/system.out)" = "system-marker" ] ||
  fail "SYSTEM output mismatch: [$(cat /tmp/system.out)]"
echo "SYSTEM verified"

# (9) SHELL takes its interpreter from $SHELL.
SHELL=/bin/sh socat -u "SHELL:echo shell-marker" - \
  >/tmp/shell.out 2>/tmp/shell.err ||
  fail "SHELL failed: $(cat /tmp/shell.err)"
[ "$(cat /tmp/shell.out)" = "shell-marker" ] ||
  fail "SHELL output mismatch: [$(cat /tmp/shell.out)]"
echo "SHELL verified"

# (10) Option "nofork": no child at all, the program execs over socat itself.
socat -u FILE:/tmp/data "EXEC:/bin/cat,nofork" >/tmp/nofork.out 2>/tmp/nofork.err ||
  fail "EXEC,nofork failed: $(cat /tmp/nofork.err)"
cmp /tmp/data /tmp/nofork.out || fail "EXEC,nofork content mismatch"
echo "EXEC (nofork) verified"

# (11) Bidirectional service: a TCP connection wired to a program's stdio, the
# combination the clone() child exists for. `cat` echoes the payload back.
socat TCP4-LISTEN:9001,reuseaddr "EXEC:/bin/cat" 2>/tmp/svc.err &
svc_pid=$!
await_listen 2329 "$svc_pid"
socat - TCP4:127.0.0.1:9001 </tmp/data >/tmp/svc.out 2>/tmp/svcclient.err ||
  fail "EXEC service client failed: $(cat /tmp/svcclient.err)"
wait "$svc_pid" || fail "EXEC service failed: $(cat /tmp/svc.err)"
cmp /tmp/data /tmp/svc.out || fail "EXEC service echo mismatch"
echo "TCP + EXEC service verified"

# (12) VSOCK-CONNECT: a guest-initiated connection out to the vm-test runner,
# which echoes on (VMADDR_CID_HOST, port 7). When its stdin runs out socat
# half-closes the vsock write side; the runner drains the echo it still owes
# and closes, and socat leaves on that end of stream.
socat - VSOCK-CONNECT:2:7 </tmp/data >/tmp/vsock-host.out 2>/tmp/vsock-host.err ||
  fail "VSOCK-CONNECT failed: $(cat /tmp/vsock-host.err)"
cmp /tmp/data /tmp/vsock-host.out || fail "VSOCK-CONNECT echo mismatch"
echo "VSOCK-CONNECT to the host echo service verified"

# (13) VSOCK-LISTEN: the same exchange the other way round, with the host
# opening the connection. The marker asks the runner to dial this port and echo
# on it. Nothing here waits for the bind: the runner redials until the listener
# answers, so the marker is free to race ahead of socat.
socat - VSOCK-LISTEN:4321 </tmp/data >/tmp/vsock-guest.out 2>/tmp/vsock-guest.err &
vsock_listen_pid=$!
echo "::vsock::connect 4321"
wait "$vsock_listen_pid" || fail "VSOCK-LISTEN failed: $(cat /tmp/vsock-guest.err)"
cmp /tmp/data /tmp/vsock-guest.out || fail "VSOCK-LISTEN echo mismatch"
echo "VSOCK-LISTEN served a host-initiated connection"

# (14) Both ends in the guest over CID 1, VMADDR_CID_LOCAL, which the kernel
# serves from its loopback transport without the virtio device seeing a packet.
# AF_VSOCK has no /proc listing to poll and a throwaway probe would eat the one
# connection this listener accepts, so the real client does the polling: a
# connect to a port nothing has bound yet is reset at once rather than hanging.
socat -u VSOCK-LISTEN:4322 CREATE:/tmp/vsock-loop.out 2>/tmp/vsock-loop.err &
vsock_loop_pid=$!
attempts=0
until socat -u FILE:/tmp/data VSOCK-CONNECT:1:4322 2>/tmp/vsock-loopclient.err; do
  kill -0 "$vsock_loop_pid" 2>/dev/null ||
    fail "loopback VSOCK-LISTEN exited: $(cat /tmp/vsock-loop.err)"
  attempts=$((attempts + 1))
  [ "$attempts" -lt 100000 ] ||
    fail "loopback VSOCK-CONNECT never landed: $(cat /tmp/vsock-loopclient.err)"
done
wait "$vsock_loop_pid" || fail "loopback VSOCK-LISTEN failed: $(cat /tmp/vsock-loop.err)"
cmp /tmp/data /tmp/vsock-loop.out || fail "VSOCK loopback content mismatch"
echo "VSOCK loopback relay verified"

# (15) The "fork" address option needs a returning-twice fork(), which this
# platform has no way to provide. It must fail loudly rather than serve one
# connection and quietly stop listening.
socat TCP4-LISTEN:9002,reuseaddr,fork "EXEC:/bin/cat" >/tmp/fork.out 2>&1 &
fork_pid=$!
await_listen 232A "$fork_pid"
socat -u FILE:/tmp/data TCP4:127.0.0.1:9002 >/dev/null 2>&1
wait "$fork_pid"
forkrc=$?
[ "$forkrc" -ne 0 ] ||
  fail "socat with option fork unexpectedly succeeded: $(cat /tmp/fork.out)"
grep -q 'address option "fork" is not supported on this platform' /tmp/fork.out ||
  fail "option fork gave no platform diagnostic: $(cat /tmp/fork.out)"
echo "option fork rejected with a platform diagnostic (rc=$forkrc)"

echo "::vm-test::pass"
while :; do :; done
