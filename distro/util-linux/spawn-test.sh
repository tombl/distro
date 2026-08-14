#!/bin/sh
# Exercises the two tools whose child creation was made forkless:
# flock (advisory locking, -c uses posix_spawn) and setsid (private-memory
# callback clone). Timer assertions use the real wall clock and a generous
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
setsid --fork sleep 5
setsid_rc=$?
setsid_end=$(date +%s) || fail "reading setsid end time failed"
setsid_elapsed=$((setsid_end - setsid_start))
[ "$setsid_rc" -eq 0 ] || fail "setsid --fork returned $setsid_rc instead of 0"
[ "$setsid_elapsed" -lt 5 ] || fail "setsid --fork waited for its command (${setsid_elapsed}s)"

setsid --fork --wait sh -c 'exit 7'
[ "$?" = "7" ] || fail "setsid --fork --wait did not propagate exit status 7"

# Without --fork, this shell's command child is not a process-group leader, so
# setsid stays in-process via setsid()+execvp() and naturally preserves status.
setsid sh -c 'exit 7'
[ "$?" = "7" ] || fail "plain setsid did not propagate exit status 7"

# Prove the command is the leader of its new session. Fields 1 and 6 of
# /proc/<pid>/stat are pid and session id. POSIX/Linux setsid semantics require
# these to match; merely differing from the caller's session is insufficient.
read -r _ _ _ _ _ pses _ </proc/self/stat
# shellcheck disable=SC2016 # The nested shell expands its own pid/session fields.
setsid --wait sh -c \
  'read -r p _ _ _ _ s _ </proc/self/stat; printf "%s %s\n" "$p" "$s" >/tmp/sid.stat'
read -r spid sses </tmp/sid.stat
[ -n "$sses" ] || fail "setsid: empty child session id"
[ "$sses" != "$pses" ] || fail "setsid: child stayed in caller's session ($sses)"
[ "$sses" = "$spid" ] || fail "setsid: child pid $spid differs from session id $sses"

echo "::vm-test::pass"
while :; do :; done
