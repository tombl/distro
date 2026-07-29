#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export TERM=xterm

# less owns its runtime closure: its package output must carry ncurses' data,
# found through the default FHS path compiled into the library.
[ -f /share/terminfo/x/xterm ] || fail "less did not ship xterm terminfo"

# Prove the GNU less shadows busybox's less applet.
less --version | grep -q '^less ' || fail "not running GNU less"

# Non-interactive: less on a file (stdout not a tty) behaves like cat.
printf 'line one\nline two\nline three\n' >/tmp/f.txt
out=$(less /tmp/f.txt)
[ "$out" = "$(printf 'line one\nline two\nline three')" ] ||
  fail "non-interactive less did not cat the file: $out"

# Interactive pty session driven by busybox script(1): open a file, jump to end
# with G, then quit with q. Assert the pager rendered file content on the pty.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /dev/pts || fail "creating /dev/pts failed"
mount -t devpts devpts /dev/pts || fail "mounting devpts failed"
mount -t proc proc /proc || fail "mounting proc failed"

seq 1 100 >/tmp/big.txt
# Keep less blocked in iread() long enough for SIGWINCH to interrupt it. The
# handler longjmps out of the read; delayed input must still page to the end and
# quit normally afterward.
mkfifo /tmp/less-input || fail "creating less input fifo failed"
script -q -c 'less /tmp/big.txt' /dev/null \
  </tmp/less-input >/tmp/typescript 2>/dev/null &
session_pid=$!
exec 3>/tmp/less-input || fail "opening less input fifo failed"

sleep 1
pager_pid=$(pidof less) || fail "less did not start under the pty"
kill -WINCH "$pager_pid" || fail "sending SIGWINCH to less failed"
printf 'Gq' >&3
exec 3>&-
wait "$session_pid" ||
  fail "script failed to run less under a pty"

tr -d '\r' </tmp/typescript >/tmp/clean
# After G the last lines of the file are on screen; line 100 must appear.
grep -q '100' /tmp/clean || fail "less did not page to end of file: $(cat /tmp/clean)"
# The prompt at end-of-file shows (END).
grep -q 'END' /tmp/clean || fail "less did not show the (END) prompt: $(cat /tmp/clean)"

echo "::vm-test::pass"
while :; do :; done
