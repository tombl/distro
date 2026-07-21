#!/bin/busybox sh
# Exercises the two tools whose fork+exec was converted to posix_spawn:
# flock (advisory locking, -c spawns a shell) and setsid (new session via
# POSIX_SPAWN_SETSID). Timer assertions use the real wall clock and a generous
# upper bound below the host VM deadline.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# posix_spawn'd children run /bin/sh, which needs a working /dev; setsid's
# assertion reads the child's /proc entry.
mount -t devtmpfs devtmpfs /dev || fail "mount devtmpfs"
mount -t proc proc /proc || fail "mount proc"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

# --- flock: -c runs a command through the shell (posix_spawn path) ----------
out=$(flock /tmp/lockA -c 'echo locked-ok')
[ "$out" = "locked-ok" ] || fail "flock -c output: [$out]"

# Exit status of the spawned command propagates back through flock.
flock /tmp/lockA -c 'exit 7'
[ "$?" = "7" ] || fail "flock -c did not propagate exit status"

# --- flock: the lock actually excludes --------------------------------------
# Hold LOCK_EX on fd 9 in this shell, then have a *second*, independent flock
# try to take the same file non-blocking: it must fail while the lock is held,
# and succeed once released. This proves flock(2) works and that two writers
# are mutually excluded.
exec 9>/tmp/lockB
flock -n 9 || fail "could not acquire lock on fd 9"

if flock -n /tmp/lockB -c true; then
  fail "second flock acquired an already-held lock"
fi

flock_start=$(date +%s) || fail "reading flock start time failed"
flock -w 1 /tmp/lockB -c true
flock_rc=$?
flock_end=$(date +%s) || fail "reading flock end time failed"
flock_elapsed=$((flock_end - flock_start))
[ "$flock_rc" -eq 1 ] || fail "timed flock returned $flock_rc instead of 1"
[ "$flock_elapsed" -ge 1 ] || fail "flock timed out too early (${flock_elapsed}s)"
[ "$flock_elapsed" -le 5 ] || fail "flock timed out too late (${flock_elapsed}s)"

exec 9>&- # close fd 9, releasing the lock
flock -n /tmp/lockB -c true || fail "flock could not acquire a freed lock"

# --- setsid: --fork returns, while --wait and direct exec propagate status --
setsid_start=$(date +%s) || fail "reading setsid start time failed"
setsid --fork busybox sleep 5
setsid_rc=$?
setsid_end=$(date +%s) || fail "reading setsid end time failed"
setsid_elapsed=$((setsid_end - setsid_start))
[ "$setsid_rc" -eq 0 ] || fail "setsid --fork returned $setsid_rc instead of 0"
[ "$setsid_elapsed" -lt 5 ] || fail "setsid --fork waited for its command (${setsid_elapsed}s)"

setsid --fork --wait busybox sh -c 'exit 7'
[ "$?" = "7" ] || fail "setsid --fork --wait did not propagate exit status 7"

# Without --fork, this shell's command child is not a process-group leader, so
# setsid stays in-process via setsid()+execvp() and naturally preserves status.
setsid busybox sh -c 'exit 7'
[ "$?" = "7" ] || fail "plain setsid did not propagate exit status 7"

# Prove the command really landed in a *new* session. Field 6 of
# /proc/<pid>/stat is the session id. The caller (this init shell) has one
# session; a child spawned without setsid would inherit it, so a child under
# setsid having a different session id proves setsid took effect.
#
# NOTE: on this platform the new session's id equals the setsid *tool's* pid
# rather than the exec'd child's own pid (musl runs setsid() inside the
# CLONE_VM posix_spawn child), so we assert "new session", not "sid == child
# pid". See PLATFORM ISSUES in package.nix.
pses=$(awk '{print $6}' /proc/self/stat)
setsid --wait busybox sh -c 'cat /proc/self/stat >/tmp/sid.stat'
sses=$(awk '{print $6}' /tmp/sid.stat)
[ -n "$sses" ] || fail "setsid: empty child session id"
[ "$sses" != "$pses" ] || fail "setsid: child stayed in caller's session ($sses)"

echo "::vm-test::pass"
while :; do :; done
