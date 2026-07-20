#!/bin/busybox sh

# The three coreutils that launched a child with fork+exec have been converted
# to posix_spawn (clone+exec), the only child-process primitive on this
# fork-less platform. This test drives each converted path end to end:
# install -s (spawns the strip helper), split --filter (spawns a shell with
# the chunk on its stdin), and timeout (spawns and waits on the command).

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/gnu/bin:/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

install --version >/tmp/iv || fail "install --version failed"
grep -q 'GNU coreutils' /tmp/iv || fail "install is not GNU coreutils"

work=/tmp/coreutils-spawn
rm -rf "$work"
mkdir -p "$work" || fail "mkdir failed"

# --- timeout: spawns the command via posix_spawn and waits on it. ------------
out=$(timeout 10 seq 1 3) || fail "timeout failed"
[ "$(printf '%s' "$out" | tr '\n' ' ')" = "1 2 3" ] ||
  fail "timeout did not relay the command output (got '$out')"
# A command that exits non-zero must propagate that status through timeout.
if timeout 10 false 2>/dev/null; then
  fail "timeout masked the command's non-zero exit"
fi

# setitimer/SIGALRM must enforce the deadline, kill the sleeping child, and
# return timeout's conventional status. The real wall clock proves this was a
# one-second timeout rather than the child completing its 30-second sleep.
timeout_start=$(date +%s) || fail "reading timeout start time failed"
timeout 1 sleep 30
timeout_rc=$?
timeout_end=$(date +%s) || fail "reading timeout end time failed"
timeout_elapsed=$((timeout_end - timeout_start))
[ "$timeout_rc" -eq 124 ] || fail "timeout returned $timeout_rc instead of 124"
[ "$timeout_elapsed" -ge 1 ] || fail "timeout fired too early (${timeout_elapsed}s)"
[ "$timeout_elapsed" -le 5 ] || fail "timeout fired too late (${timeout_elapsed}s)"

# --- split --filter: each chunk is piped to a freshly spawned shell running
# the filter, with $FILE set to the piece name. 'cat > "$FILE"' therefore
# reconstructs each piece, proving the pipe/dup2/spawn plumbing works. ---
printf '%s\n' a b c d >"$work/in" || fail "writing split input failed"
# shellcheck disable=SC2016 # $FILE must expand in the spawned filter shell
split -l 2 --filter='cat > "$FILE"' "$work/in" "$work/piece_" ||
  fail "split --filter failed"
[ -f "$work/piece_aa" ] || fail "split --filter did not create the first piece"
[ -f "$work/piece_ab" ] || fail "split --filter did not create the second piece"
[ "$(tr '\n' ' ' <"$work/piece_aa")" = "a b " ] ||
  fail "split --filter's shell child produced the wrong first piece"
[ "$(tr '\n' ' ' <"$work/piece_ab")" = "c d " ] ||
  fail "split --filter's shell child produced the wrong second piece"

# --- install -s: posix_spawns the strip program on the freshly copied file.
# A stub strip records that it ran and truncates the file, so we can assert the
# spawn actually happened (not just that install copied the bytes). ---
# shellcheck disable=SC2016 # $1 must expand when the stub runs, not here
printf '#!/bin/busybox sh\nprintf ran > /tmp/coreutils-spawn/strip-ran\n: > "$1"\n' \
  >"$work/mystrip" || fail "writing strip stub failed"
chmod 0755 "$work/mystrip" || fail "chmod strip stub failed"
printf 'payload\n' >"$work/src" || fail "writing install source failed"
install -s --strip-program="$work/mystrip" -m 0755 \
  "$work/src" "$work/installed" || fail "install -s failed"
[ -f "$work/installed" ] || fail "install -s did not create its destination"
[ -f "$work/strip-ran" ] || fail "install -s never spawned the strip program"
mode=$(stat -c '%a' "$work/installed") || fail "stat on installed file failed"
[ "$mode" = 755 ] || fail "install -s produced mode $mode instead of 755"

echo "::vm-test::pass"
while :; do :; done
