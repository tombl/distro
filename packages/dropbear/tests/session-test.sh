#!/bin/busybox sh
# End-to-end dropbear check: generate keys, then run one real SSH exec session
# over loopback with pubkey auth (server = `dropbear -i` behind the tcp-spawn
# listener fixture, client = dbclient), and assert both the success output and
# the wrong-key failure mode.

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export HOME=/root

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc 2>/dev/null
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
tcp-spawn "$PORT" /tmp/listener-ready \
  /bin/dropbear -i -E -s -r /etc/dropbear/host_ed25519 &
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

# (5) Negative session: an unauthorised key must be rejected cleanly (non-zero
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
