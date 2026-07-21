#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export HOME=/root
export TERM=xterm
# vim's system() builds `sh -c "<cmd>"`; make sure that shell is busybox's.
export SHELL=/bin/sh

# vim's system() (posix_spawn) execs /bin/sh, which opens /dev/null; the shell
# and its children need a populated /dev.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /root /tmp
cd /tmp || fail "cd /tmp failed"

# --- version / feature assertions -------------------------------------------
vim --version >/tmp/ver 2>&1 || fail "vim --version failed: $(cat /tmp/ver)"
grep -q '9\.1' /tmp/ver || fail "unexpected version banner: $(head -1 /tmp/ver)"
grep -q 'Included patches: 1-2148' /tmp/ver || fail "unexpected patch level"
# Proof the USE_SYSTEM shell-out switch took effect: version.c prints "+system()"
# only under USE_SYSTEM, and never emits a "fork()" token in that case.
grep -q '+system()' /tmp/ver || fail "expected +system() (USE_SYSTEM not active)"
grep -q 'fork()' /tmp/ver && fail "unexpected fork() token in :version"
# Scripting must be present for ex-mode editing; GUI/X must be absent.
grep -q '+eval' /tmp/ver || fail "expected +eval"
grep -q '\-channel' /tmp/ver || fail "expected -channel (channel disabled)"
grep -q '\-python3' /tmp/ver || fail "expected -python3 (no interpreters)"
[ -f /share/terminfo/x/xterm ] || fail "vim fragment is missing xterm terminfo"

# --- non-interactive editing: substitution + multi-line edit + write --------
printf 'foo one\nfoo two\nfoo three\n' >edit.txt
# The single-quoted arguments below are vim ex commands ($ is "last line" /
# "end of line" in vim), not shell expansions, so single quotes are correct.
# shellcheck disable=SC2016 # $ is Vim syntax inside the single-quoted commands
vim -u NONE -N -es \
  -c '%s/foo/bar/g' \
  -c '2s/$/ EDITED/' \
  -c '$s/$/ LAST/' \
  -c 'wq' edit.txt </dev/null || fail "ex editing session failed"

printf 'bar one\nbar two EDITED\nbar three LAST\n' >edit.expect
cmp -s edit.txt edit.expect ||
  fail "edited file mismatch: got [$(cat edit.txt)]"

# --- shell-out proves the system()/posix_spawn path -------------------------
# (1) :r! pulls a child process's stdout into the buffer.
: >read.txt
vim -u NONE -N -es \
  -c 'r! echo spawned-via-system' \
  -c 'wq' read.txt </dev/null || fail ":r! session failed"
grep -q '^spawned-via-system$' read.txt ||
  fail ":r! did not capture child output: [$(cat read.txt)]"

# (2) :%!filter runs the buffer through an external command.
printf 'lower case text\n' >filt.txt
vim -u NONE -N -es \
  -c '%!tr a-z A-Z' \
  -c 'wq' filt.txt </dev/null || fail ":%! filter session failed"
[ "$(cat filt.txt)" = 'LOWER CASE TEXT' ] ||
  fail ":%! filter wrong output: [$(cat filt.txt)]"

# (3) a bare :! writing to a file, the clearest end-to-end spawn.
rm -f /tmp/bang-marker
printf 'x\n' >bang.txt
vim -u NONE -N -es \
  -c '!echo bang-ran >/tmp/bang-marker' \
  -c 'qa!' bang.txt </dev/null || fail ":! session failed"
[ "$(cat /tmp/bang-marker 2>/dev/null)" = bang-ran ] ||
  fail ":! shell command did not run (posix_spawn child failed)"

# --- xxd round-trip ---------------------------------------------------------
printf 'RoundTrip-\x00\x01\x02-9128!\n' >x.bin
xxd x.bin >x.hex || fail "xxd encode failed"
grep -q 'RoundTrip' x.hex || fail "xxd output has no ascii column"
xxd -r x.hex >x.out || fail "xxd -r decode failed"
cmp -s x.bin x.out || fail "xxd round-trip mismatch"

echo "::vm-test::pass"
while :; do :; done
