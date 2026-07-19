#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# No TERMINFO in the environment: the database must be found via the search
# directory compiled into the library (/share/terminfo, where the rootfs
# flattens ncurses' $out/share/terminfo).
[ -f /share/terminfo/l/linux ] || fail "terminfo database not shipped at /share/terminfo"
[ -f /share/terminfo/x/xterm-256color ] || fail "xterm-256color terminfo entry missing"

output=$(ncurses-test) || fail "ncurses-test exited nonzero: $output"
echo "$output"
printf '%s\n' "$output" | grep -q NCURSES-TEST-PASS || fail "ncurses capabilities check failed"

echo "::vm-test::pass"
while :; do :; done
