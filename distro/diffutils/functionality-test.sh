#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# diff3 spawns a child `diff` via popen (posix_spawn on wasm); /bin/sh needs a
# working /dev.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"

# Prove the GNU binaries shadow busybox's diff/cmp applets.
diff --version | grep -q 'GNU diffutils' || fail "not running GNU diff"
cmp --version | grep -q 'GNU diffutils' || fail "not running GNU cmp"

printf 'alpha\nbeta\ngamma\n' >/tmp/a
printf 'alpha\nBETA\ngamma\n' >/tmp/b
cp /tmp/a /tmp/a2

# Differing files: exit status 1 and the expected normal-diff hunk.
out=$(diff /tmp/a /tmp/b)
status=$?
[ "$status" = "1" ] || fail "diff exit status: $status"
echo "$out" | grep -q '^< beta' || fail "diff missing '< beta': $out"
echo "$out" | grep -q '^> BETA' || fail "diff missing '> BETA': $out"

# Unified diff: exit 1, with @@ hunk header and +/- lines.
out=$(diff -u /tmp/a /tmp/b)
status=$?
[ "$status" = "1" ] || fail "diff -u exit status: $status"
echo "$out" | grep -q '^@@' || fail "diff -u missing hunk header: $out"
echo "$out" | grep -q '^-beta' || fail "diff -u missing -beta: $out"
echo "$out" | grep -q '^+BETA' || fail "diff -u missing +BETA: $out"

# Identical files: exit status 0, no output.
out=$(diff /tmp/a /tmp/a2)
status=$?
[ "$status" = "0" ] || fail "diff identical exit status: $status"
[ -z "$out" ] || fail "diff identical produced output: $out"

# cmp: identical -> 0, differing -> 1.
cmp /tmp/a /tmp/a2 || fail "cmp identical returned nonzero"
cmp /tmp/a /tmp/b >/dev/null 2>&1
[ "$?" = "1" ] || fail "cmp differing did not return 1"

# diff3 spawns a `diff` child (the posix_spawn/popen path). Give it three files
# where b and c each change a distinct line of a; -m merges without conflict.
printf 'one\ntwo\nthree\n' >/tmp/d3a
printf 'ONE\ntwo\nthree\n' >/tmp/d3b
printf 'one\ntwo\nTHREE\n' >/tmp/d3c
out=$(diff3 -m /tmp/d3b /tmp/d3a /tmp/d3c)
status=$?
[ "$status" = "0" ] || fail "diff3 -m exit status: $status"
echo "$out" | grep -q '^ONE' || fail "diff3 -m missing ONE: $out"
echo "$out" | grep -q '^THREE' || fail "diff3 -m missing THREE: $out"

echo "::vm-test::pass"
while :; do :; done
