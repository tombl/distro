#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

# (a) --version must report the OpenSSL backend and the expected protocols.
curl --version >/tmp/ver 2>&1 || fail "curl --version failed: $(cat /tmp/ver)"
grep -qi openssl /tmp/ver || fail "OpenSSL backend not reported: $(cat /tmp/ver)"
protocols=$(grep -i '^Protocols:' /tmp/ver) || fail "no Protocols line: $(cat /tmp/ver)"
for p in file http https; do
  echo "$protocols" | grep -qw "$p" || fail "protocol $p missing from: $protocols"
done

# HTTPS leaves the guest through the host Fetch bridge, so curl must not bake a
# nonexistent guest trust-store path into the package.
[ -z "$(curl-config --ca)" ] || fail "unexpected default CA bundle: $(curl-config --ca)"

# (b) file:// round trip: fetch a local file through curl and byte-compare.
: >/tmp/data
i=0
while [ "$i" -lt 200 ]; do
  printf 'line %d the quick brown fox jumps over 0123456789\n' "$i" >>/tmp/data
  i=$((i + 1))
done
curl -sS file:///tmp/data -o /tmp/out 2>/tmp/curlerr ||
  fail "file:// fetch failed (rc=$?): $(cat /tmp/curlerr)"
cmp /tmp/data /tmp/out || fail "file:// round trip content mismatch"

# (c) Real loopback HTTP round trip. Readiness is the observable LISTEN state,
# not a timing sleep. curl's progress timers initialize against working POSIX
# timers; the host's 20-second VM deadline bounds an actual transfer hang.
ip link set lo up 2>/tmp/iperr || fail "bringing up loopback failed: $(cat /tmp/iperr)"
mkdir -p /www || fail "creating HTTP root failed"
cp /tmp/data /www/data || fail "creating HTTP fixture failed"
httpd -f -p 127.0.0.1:8080 -h /www &
httpd_pid=$!

attempts=0
while kill -0 "$httpd_pid" 2>/dev/null; do
  if awk '$2 ~ /:1F90$/ && $4 == "0A" { found = 1 } END { exit !found }' /proc/net/tcp; then
    break
  fi
  attempts=$((attempts + 1))
  [ "$attempts" -lt 100000 ] || fail "httpd did not publish its listening socket"
done
kill -0 "$httpd_pid" 2>/dev/null || fail "httpd exited before becoming ready"

curl -sS http://127.0.0.1:8080/data -o /tmp/hout 2>/tmp/curlerr ||
  fail "HTTP fetch failed: $(cat /tmp/curlerr)"
cmp /tmp/data /tmp/hout || fail "HTTP round trip content mismatch"
kill "$httpd_pid" 2>/dev/null || :
wait "$httpd_pid" 2>/dev/null || :

echo "::vm-test::pass"
while :; do :; done
