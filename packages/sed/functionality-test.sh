#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# Prove the GNU sed shadows busybox's applet rather than the other way around.
sed --version | grep -q 'GNU sed' || fail "not running GNU sed"

# Basic substitution.
out=$(printf 'hello world\n' | sed 's/world/there/')
[ "$out" = "hello there" ] || fail "basic substitution: $out"

# Global substitution flag.
out=$(printf 'a a a\n' | sed 's/a/b/g')
[ "$out" = "b b b" ] || fail "global substitution: $out"

# Address range: print only lines 2-3 with -n.
out=$(printf '1\n2\n3\n4\n' | sed -n '2,3p')
[ "$out" = "$(printf '2\n3')" ] || fail "address range: $out"

# Delete by regex address.
out=$(printf 'keep\ndrop me\nkeep\n' | sed '/drop/d')
[ "$out" = "$(printf 'keep\nkeep')" ] || fail "regex-address delete: $out"

# Extended regex (-E) with alternation and backreference.
out=$(printf 'foobar\n' | sed -E 's/(foo|baz)bar/\1-matched/')
[ "$out" = "foo-matched" ] || fail "extended regex: $out"

# Multiple -e expressions applied in order.
out=$(printf 'one\n' | sed -e 's/one/two/' -e 's/two/three/')
[ "$out" = "three" ] || fail "multi-expression: $out"

# In-place editing (-i).
printf 'red\ngreen\nblue\n' >/tmp/colors
sed -i 's/green/GREEN/' /tmp/colors || fail "sed -i exited nonzero"
grep -q '^GREEN$' /tmp/colors || fail "sed -i did not edit the file"
grep -q '^red$' /tmp/colors || fail "sed -i clobbered unrelated lines"

echo "::vm-test::pass"
while :; do :; done
