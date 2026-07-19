#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# Prove the GNU make shadows busybox's make applet (if any) and runs at all.
make --version | grep -q 'GNU Make' || fail "not running GNU make"

cd /tmp || fail "cd /tmp"
mkdir -p work || fail "mkdir work"
cd work || fail "cd work"

# A Makefile with a dependency chain: out <- mid <- in. Recipes use shell
# redirection, cat, and touch, so each recipe is a posix_spawned /bin/sh -c.
cat >Makefile <<'EOF'
all: out

out: mid
	cat mid > out
	echo done >> out

mid: in
	cat in > mid
	echo mid-built >> mid

in:
	echo in-built > in

world: $(shell echo w1 w2)

w1:
	echo one > w1
w2:
	echo two > w2

fails:
	echo before
	false
	echo after > should-not-exist

.PHONY: all world clean
clean:
	rm -f in mid out w1 w2
EOF

# 1. First build: every target runs in dependency order.
make >log1 2>&1 || fail "first make failed: $(cat log1)"
[ -f out ] || fail "out not created"
grep -q 'in-built' out || fail "out missing in-built content: $(cat out)"
grep -q 'mid-built' out || fail "out missing mid-built content"
grep -q 'done' out || fail "out missing done marker"

# 2. Second build with no changes is a no-op (nothing to rebuild).
out2=$(make 2>&1)
case $out2 in
*'Nothing to be done'* | *'up to date'*) : ;;
*) fail "second make was not a no-op: $out2" ;;
esac

# 3. Touching a prerequisite rebuilds only its dependents. Make mtimes advance.
sleep 1
touch in
make >log3 2>&1 || fail "rebuild after touch failed: $(cat log3)"
grep -q 'cat mid > out' log3 || fail "touching in did not rebuild out: $(cat log3)"

# 4. Parallel build of two independent targets with -j2. Both must appear.
make clean >/dev/null 2>&1
make -j2 world >logj 2>&1 || fail "parallel make -j2 failed: $(cat logj)"
[ -f w1 ] && [ -f w2 ] || fail "parallel build did not produce both outputs"
[ "$(cat w1)" = one ] || fail "w1 wrong: $(cat w1)"
[ "$(cat w2)" = two ] || fail "w2 wrong: $(cat w2)"

# 5. $(shell ...) expansion worked: the 'world' prerequisites came from a
#    $(shell echo w1 w2), so both files existing proves $(shell) ran.

# 6. A failing recipe (false) stops the build with nonzero exit, and the
#    command after the failure never runs.
make fails >logf 2>&1
status=$?
[ "$status" -ne 0 ] || fail "failing recipe did not stop the build (exit 0)"
[ -f should-not-exist ] && fail "make continued past a failed recipe"
grep -q before logf || fail "recipe before the failure did not run"

echo "::vm-test::pass"
while :; do :; done
