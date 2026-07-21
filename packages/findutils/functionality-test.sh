#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# xargs redirects a child's stdin from /dev/null; provide a real /dev.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"

# Prove the GNU binaries shadow busybox's find/xargs applets.
# shellcheck disable=SC2185 # --version needs no path
find --version | grep -q 'GNU findutils' || fail "not running GNU find"
xargs --version | grep -q 'GNU findutils' || fail "not running GNU xargs"

# Build a small tree to search.
mkdir -p /tmp/t/a/b /tmp/t/c
echo hello >/tmp/t/a/one.txt
echo world >/tmp/t/a/b/two.txt
echo '#!/bin/sh' >/tmp/t/c/script.sh
mkdir -p /tmp/t/d

# -name matches by basename.
out=$(find /tmp/t -name '*.txt' | sort | tr '\n' ' ')
[ "$out" = "/tmp/t/a/b/two.txt /tmp/t/a/one.txt " ] || fail "-name: $out"

# -type d lists only directories.
out=$(find /tmp/t -type d | sort | tr '\n' ' ')
[ "$out" = "/tmp/t /tmp/t/a /tmp/t/a/b /tmp/t/c /tmp/t/d " ] || fail "-type d: $out"

# -mindepth skips the top levels (two.txt is the only file at depth >= 3).
out=$(find /tmp/t -mindepth 3 -type f | sort | tr '\n' ' ')
[ "$out" = "/tmp/t/a/b/two.txt " ] || fail "-mindepth: $out"

# -exec {} + batches all arguments into one command: the posix_spawn path.
# The single echo emits one line; split and sort the tokens for determinism.
out=$(find /tmp/t -type f -exec echo {} + | tr ' ' '\n' | sort | tr '\n' ' ')
exp="/tmp/t/a/b/two.txt /tmp/t/a/one.txt /tmp/t/c/script.sh "
[ "$out" = "$exp" ] || fail "-exec + : $out"

# -exec ... \; runs one command per file: also the posix_spawn path.
count=$(find /tmp/t -type f -exec basename {} \; | wc -l | tr -d ' ')
[ "$count" = "3" ] || fail "-exec \\; count: $count"

# A command that could not be spawned makes the semicolon-form predicate
# false, so a following action must not run.
out=$(find /tmp/t -type f -exec no-such-command-xyz {} \; -print 2>/dev/null)
[ -z "$out" ] || fail "failed -exec satisfied predicate: $out"

# xargs feeds found names to a command it spawns via posix_spawn. cat each
# file and confirm the combined contents.
out=$(find /tmp/t -name '*.txt' -print | sort | xargs cat | sort | tr '\n' ' ')
[ "$out" = "hello world " ] || fail "xargs cat: $out"

# xargs -n1 spawns one child per argument; -I{} substitutes.
out=$(printf 'x\ny\nz\n' | xargs -n1 echo item | sort | tr '\n' ' ')
[ "$out" = "item x item y item z " ] || fail "xargs -n1: $out"

# updatedb's generated helper paths and locate's default database must all be
# guest paths. Build /var/locatedb without path overrides, then query it through
# locate's compiled default.
mkdir -p /var || fail "creating /var"
updatedb --localpaths=/tmp/t || fail "updatedb with default output failed"
[ -s /var/locatedb ] || fail "updatedb did not create /var/locatedb"
out=$(locate 'one.txt') || fail "locate default database query failed"
[ "$out" = "/tmp/t/a/one.txt" ] || fail "locate default database: $out"

# xargs must report a nonexistent command as not-found (exit 127) via the
# posix_spawnp return value, not hang.
printf 'a\n' | xargs no-such-command-xyz 2>/dev/null
status=$?
[ "$status" = "127" ] || fail "xargs missing command exit: $status"

echo "::vm-test::pass"
while :; do :; done
