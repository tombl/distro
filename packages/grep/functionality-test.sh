#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# Prove the GNU grep shadows busybox's applet rather than the other way around.
grep --version | grep -q 'GNU grep' || fail "not running GNU grep"

# Fixed-string match (-F).
out=$(printf 'a.b\naxb\n' | grep -F 'a.b')
[ "$out" = "a.b" ] || fail "fixed-string match: $out"

# Basic regex (BRE): anchors and escaped interval.
out=$(printf 'aa\naaa\n' | grep '^a\{3\}$')
[ "$out" = "aaa" ] || fail "basic regex interval: $out"

# Extended regex (-E): alternation.
out=$(printf 'cat\ndog\nfish\n' | grep -E 'cat|fish')
[ "$out" = "$(printf 'cat\nfish')" ] || fail "extended regex: $out"

# Count (-c).
n=$(printf 'x\ny\nx\nx\n' | grep -c x)
[ "$n" = 3 ] || fail "count: $n"

# Only-matching (-o).
out=$(printf 'key=value\n' | grep -oE '[a-z]+')
[ "$out" = "$(printf 'key\nvalue')" ] || fail "only-matching: $out"

# Invert (-v).
out=$(printf 'keep\ndrop\nkeep\n' | grep -v drop)
[ "$out" = "$(printf 'keep\nkeep')" ] || fail "invert: $out"

# Recursive (-r) over a small tree.
mkdir -p /tmp/tree/sub
printf 'needle here\n' >/tmp/tree/a.txt
printf 'nothing\n' >/tmp/tree/sub/b.txt
printf 'needle again\n' >/tmp/tree/sub/c.txt
n=$(grep -rl needle /tmp/tree | grep -c .)
[ "$n" = 2 ] || fail "recursive found $n files, expected 2"

# Exit status: 0 when matched, 1 when not, on a clean input.
printf 'hello\n' | grep -q hello || fail "exit status not 0 on match"
if printf 'hello\n' | grep -q goodbye; then
  fail "exit status 0 on no match (expected 1)"
fi

echo "::vm-test::pass"
while :; do :; done
