#!/bin/busybox sh
# End-to-end dropbear check: generate keys, then run one real SSH exec session
# over loopback with pubkey auth (server = `dropbear -i` behind the tcp-spawn
# listener fixture, client = dbclient), and assert both the success output and
# the wrong-key failure mode.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export HOME=/root

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /dev/pts || fail "creating /dev/pts failed"
mount -t devpts devpts /dev/pts || fail "mounting devpts failed"
mount -t proc proc /proc 2>/dev/null
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"
mount -t sysfs sysfs /sys 2>/dev/null

# Loopback is down at boot; the SSH session runs over 127.0.0.1.
ip link set lo up || fail "'ip link set lo up' failed"

PORT=2222

# A minimal account database so the server's getpwnam("root") resolves to a
# home and shell. The guest clock sits at 1970, but ed25519 keys and SSH auth
# carry no time validity, so timestamps do not matter here.
mkdir -p /etc /root/.ssh /etc/dropbear || fail "mkdir failed"
echo "root:x:0:0:root:/root:/bin/sh" >/etc/passwd || fail "writing passwd failed"
echo "root:x:0:" >/etc/group || fail "writing group failed"
echo "vm-guest" >/etc/hostname || fail "writing hostname failed"

# (1) Host key + fingerprint. dropbearkey must generate an ed25519 host key and
# print its fingerprint and public key.
dropbearkey -t ed25519 -f /etc/dropbear/host_ed25519 >/tmp/hostkey.out 2>&1 ||
  fail "dropbearkey host key generation failed: $(cat /tmp/hostkey.out)"
grep -q '^Fingerprint:' /tmp/hostkey.out ||
  fail "no host key fingerprint printed: $(cat /tmp/hostkey.out)"
grep -q 'ssh-ed25519 ' /tmp/hostkey.out ||
  fail "no ed25519 host public key printed: $(cat /tmp/hostkey.out)"
echo "host key fingerprint: $(grep '^Fingerprint:' /tmp/hostkey.out)"

# (2) Client key pair, and its public half authorised for root.
dropbearkey -t ed25519 -f /root/id_ed25519 >/tmp/clientkey.out 2>&1 ||
  fail "dropbearkey client key generation failed: $(cat /tmp/clientkey.out)"
grep -q '^Fingerprint:' /tmp/clientkey.out ||
  fail "no client key fingerprint printed: $(cat /tmp/clientkey.out)"

dropbearkey -y -f /root/id_ed25519 >/tmp/clientpub.out 2>&1 ||
  fail "dropbearkey -y (public key export) failed: $(cat /tmp/clientpub.out)"
grep '^ssh-ed25519 ' /tmp/clientpub.out >/root/.ssh/authorized_keys ||
  fail "could not extract client public key: $(cat /tmp/clientpub.out)"

# A second, unauthorised key for the negative test.
dropbearkey -t ed25519 -f /root/wrong_ed25519 >/tmp/wrongkey.out 2>&1 ||
  fail "dropbearkey wrong-key generation failed: $(cat /tmp/wrongkey.out)"

# Permissions dropbear insists on: home and .ssh not group/world writable,
# authorized_keys owned by the user and not writable by others.
chmod 700 /root /root/.ssh || fail "chmod home failed"
chmod 600 /root/.ssh/authorized_keys || fail "chmod authorized_keys failed"

# (3) Start the listener that posix_spawns `dropbear -i` per connection. It
# writes /tmp/listener-ready once bound so we avoid a connect-before-listen race
# (no timers on this kernel).
rm -f /tmp/listener-ready
# posix_spawn (in tcp-spawn) does no PATH search, so name dropbear by full path.
# The scope keeps FHS sbin directories intact instead of applying nixpkgs'
# sbin-to-bin move hook.
tcp-spawn "$PORT" /tmp/listener-ready \
  /sbin/dropbear -i -E -s -r /etc/dropbear/host_ed25519 &
listener_pid=$!

i=0
while [ ! -f /tmp/listener-ready ]; do
  i=$((i + 1))
  if [ "$i" -gt 100000 ]; then
    fail "listener did not become ready"
  fi
done
echo "listener ready (pid $listener_pid)"

# (4) Positive session: exec a command with pubkey auth, assert exact output.
dbclient -y -y -T -i /root/id_ed25519 -p "$PORT" root@127.0.0.1 \
  'echo MARKER; cat /etc/hostname' </dev/null >/tmp/session.out 2>/tmp/session.err
rc=$?
if [ "$rc" -ne 0 ]; then
  fail "dbclient exec session failed (rc=$rc): $(cat /tmp/session.err)"
fi

printf 'MARKER\nvm-guest\n' >/tmp/session.expected
cmp /tmp/session.out /tmp/session.expected ||
  fail "session output mismatch: got [$(cat /tmp/session.out)] want [MARKER/vm-guest]"
echo "pubkey exec session output verified"

# (5) PTY session: force allocation even though the test harness redirects the
# client's stdin, then prove both remote stdio and tty(1) see a real devpts tty.
stty rows 24 cols 80 </dev/console || fail "setting client console size failed"
dbclient -y -y -t -i /root/id_ed25519 -p "$PORT" root@127.0.0.1 \
  'tty && test -t 0 && test -t 1 && test -t 2 && stty size' \
  </dev/console >/tmp/pty.out 2>/tmp/pty.err
rc=$?
if [ "$rc" -ne 0 ]; then
  fail "dbclient PTY session failed (rc=$rc): $(cat /tmp/pty.err)"
fi
pty_name=$(sed -n '1{s/\r$//;p;}' /tmp/pty.out)
case $pty_name in
/dev/pts/*) : ;;
*) fail "PTY session did not report a devpts tty: $(cat /tmp/pty.out)" ;;
esac
pty_size=$(sed -n '2{s/\r$//;p;}' /tmp/pty.out)
pty_rows=${pty_size%% *}
pty_cols=${pty_size#* }
case $pty_rows$pty_cols in
"" | *[!0-9]*) fail "stty size was not numeric: $(cat /tmp/pty.out)" ;;
esac
[ "$pty_rows $pty_cols" = "$pty_size" ] ||
  fail "stty size did not report rows and columns: $pty_size"
[ "$pty_size" = "24 80" ] ||
  fail "PTY window size did not propagate: got $pty_size, want 24 80"
echo "PTY exec session verified on $pty_name (size $pty_size)"

# (6) Agent forwarding without a local agent must remain clean: -A is accepted,
# authentication falls back to the explicit key, and no request is sent without
# SSH_AUTH_SOCK.
unset SSH_AUTH_SOCK
dbclient -y -y -A -T -i /root/id_ed25519 -p "$PORT" root@127.0.0.1 \
  'echo NO_AGENT_OK' </dev/null >/tmp/no-agent.out 2>/tmp/no-agent.err
rc=$?
if [ "$rc" -ne 0 ] || [ "$(cat /tmp/no-agent.out)" != "NO_AGENT_OK" ]; then
  fail "dbclient -A no-agent path failed (rc=$rc): $(cat /tmp/no-agent.err)"
fi
echo "agent forwarding no-agent path verified"

# With SSH_AUTH_SOCK set, the client requests forwarding. The local endpoint is
# deliberately absent, but the server must still create and export its AF_UNIX
# listener for the command without crashing or hanging.
SSH_AUTH_SOCK=/tmp/missing-agent
export SSH_AUTH_SOCK
# shellcheck disable=SC2016 # Expand SSH_AUTH_SOCK in the remote shell.
dbclient -y -y -A -T -i /root/id_ed25519 -p "$PORT" root@127.0.0.1 \
  'test -n "$SSH_AUTH_SOCK" && test -S "$SSH_AUTH_SOCK" && echo AGENT_SOCKET_OK' \
  </dev/null >/tmp/agent.out 2>/tmp/agent.err
rc=$?
if [ "$rc" -ne 0 ] || [ "$(cat /tmp/agent.out)" != "AGENT_SOCKET_OK" ]; then
  fail "server agent socket setup failed (rc=$rc): $(cat /tmp/agent.err)"
fi
unset SSH_AUTH_SOCK
echo "server agent forwarding socket verified"

# (7) Negative session: an unauthorised key must be rejected cleanly (non-zero
# exit, no command output) and must not hang. If it hung, the host-side 20s
# timeout would fail the check loudly.
dbclient -y -y -T -i /root/wrong_ed25519 -p "$PORT" root@127.0.0.1 \
  'echo SHOULD_NOT_RUN' </dev/null >/tmp/bad.out 2>/tmp/bad.err
badrc=$?
if [ "$badrc" -eq 0 ]; then
  fail "wrong-key session unexpectedly succeeded: $(cat /tmp/bad.out)"
fi
if grep -q SHOULD_NOT_RUN /tmp/bad.out; then
  fail "wrong-key session ran the command: $(cat /tmp/bad.out)"
fi
echo "wrong-key auth rejected cleanly (rc=$badrc)"

echo "::vm-test::pass"
while :; do :; done
