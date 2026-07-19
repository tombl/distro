#!/bin/busybox sh

# The three coreutils that launched a child with fork+exec have been converted
# to posix_spawn (clone+exec), the only child-process primitive on this
# fork-less platform. This test drives each converted path end to end:
# install -s (spawns the strip helper), split --filter (spawns a shell with
# the chunk on its stdin), and timeout (spawns and waits on the command).

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

# As in the sibling tests, GNU's line/buffer-scanning tools intermittently trap
# with a wasm out-of-bounds read on this platform (see the port's PLATFORM
# ISSUES). Retry a whole command until an attempt completes; a genuine failure
# still surfaces once the retries are exhausted. REPLY holds the last stdout.
retry() {
  _i=0
  while [ "$_i" -lt 25 ]; do
    if REPLY=$("$@" 2>/dev/null); then
      return 0
    fi
    _i=$((_i + 1))
  done
  return 1
}

# Retry a command run for its side effects and exit status only.
retry_status() {
  _i=0
  while [ "$_i" -lt 25 ]; do
    if "$@" 2>/dev/null; then
      return 0
    fi
    _i=$((_i + 1))
  done
  return 1
}

export PATH=/gnu/bin:/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"

install --version >/tmp/iv || fail "install --version failed"
grep -q 'GNU coreutils' /tmp/iv || fail "install is not GNU coreutils"

work=/tmp/coreutils-spawn
rm -rf "$work"
mkdir -p "$work" || fail "mkdir failed"

# --- timeout: spawns the command via posix_spawn and waits on it. The timer
# itself is inert on this platform (SIGALRM does not fire), so the command must
# run to completion and its stdout and exit status must come back intact. ---
retry timeout 10 seq 1 3 || fail "timeout trapped on every attempt"
[ "$(printf '%s' "$REPLY" | tr '\n' ' ')" = "1 2 3" ] ||
  fail "timeout did not relay the command output (got '$REPLY')"
# A command that exits non-zero must propagate that status through timeout.
if timeout 10 false 2>/dev/null; then
  fail "timeout masked the command's non-zero exit"
fi

# --- split --filter: each chunk is piped to a freshly spawned shell running
# the filter, with $FILE set to the piece name. 'cat > "$FILE"' therefore
# reconstructs each piece, proving the pipe/dup2/spawn plumbing works. ---
printf '%s\n' a b c d >"$work/in" || fail "writing split input failed"
# shellcheck disable=SC2016 # $FILE must expand in the spawned filter shell
retry_status split -l 2 --filter='cat > "$FILE"' "$work/in" "$work/piece_" ||
  fail "split --filter trapped on every attempt"
[ -f "$work/piece_aa" ] || fail "split --filter did not create the first piece"
[ -f "$work/piece_ab" ] || fail "split --filter did not create the second piece"
retry cat "$work/piece_aa" || fail "reading piece_aa trapped"
[ "$(printf '%s' "$REPLY" | tr '\n' ' ')" = "a b" ] ||
  fail "split --filter's shell child produced the wrong first piece ('$REPLY')"
retry cat "$work/piece_ab" || fail "reading piece_ab trapped"
[ "$(printf '%s' "$REPLY" | tr '\n' ' ')" = "c d" ] ||
  fail "split --filter's shell child produced the wrong second piece ('$REPLY')"

# --- install -s: posix_spawns the strip program on the freshly copied file.
# A stub strip records that it ran and truncates the file, so we can assert the
# spawn actually happened (not just that install copied the bytes). ---
# shellcheck disable=SC2016 # $1 must expand when the stub runs, not here
printf '#!/bin/busybox sh\nprintf ran > /tmp/coreutils-spawn/strip-ran\n: > "$1"\n' \
  >"$work/mystrip" || fail "writing strip stub failed"
chmod 0755 "$work/mystrip" || fail "chmod strip stub failed"
printf 'payload\n' >"$work/src" || fail "writing install source failed"
retry_status install -s --strip-program="$work/mystrip" -m 0755 \
  "$work/src" "$work/installed" || fail "install -s trapped on every attempt"
[ -f "$work/installed" ] || fail "install -s did not create its destination"
[ -f "$work/strip-ran" ] || fail "install -s never spawned the strip program"
retry stat -c '%a' "$work/installed" || fail "stat on installed file trapped"
[ "$REPLY" = 755 ] || fail "install -s produced mode $REPLY instead of 755"

echo "::vm-test::pass"
while :; do :; done
