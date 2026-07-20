#!/bin/busybox sh

# Text processing, checksums, and the small self-contained utilities, against
# the GNU coreutils binaries (installed under /gnu/bin, ahead of busybox on
# PATH).

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/gnu/bin:/bin:/sbin:/usr/bin:/usr/sbin

sort --version | head -n1 | grep -q 'GNU coreutils' || fail "sort is not GNU coreutils"

work=/tmp/coreutils-textops
rm -rf "$work"
mkdir -p "$work"

# seq feeds most of the pipeline below.
seq 1 100 >"$work/nums" || fail "seq failed"
lines=$(wc -l "$work/nums") || fail "wc -l failed"
[ "${lines%% *}" -eq 100 ] || fail "seq/wc counted ${lines%% *} lines instead of 100"

# head / tail.
[ "$(head -n1 "$work/nums")" = 1 ] || fail "head returned the wrong first line"
[ "$(tail -n1 "$work/nums")" = 100 ] || fail "tail -n1 did not return the last line"

# wc word count.
words=$(wc -w "$work/nums") || fail "wc -w failed"
[ "${words%% *}" -eq 100 ] || fail "wc counted ${words%% *} words instead of 100"

# sort -n and uniq.
printf '%s\n' 3 1 2 2 3 1 >"$work/dups" || fail "writing dup data failed"
sort -n "$work/dups" | uniq >"$work/uniq" || fail "sort | uniq failed"
[ "$(tr '\n' ' ' <"$work/uniq")" = "1 2 3 " ] || fail "sort/uniq gave the wrong result"

# cut.
printf '%s\n' 'a:b:c' 'd:e:f' >"$work/cols" || fail "writing column data failed"
[ "$(cut -d: -f2 "$work/cols" | tr '\n' ' ')" = "b e " ] || fail "cut -f2 failed"

# tr.
[ "$(printf 'abc' | tr '[:lower:]' '[:upper:]')" = ABC ] || fail "tr failed"

# paste.
printf '%s\n' 1 2 3 >"$work/left"
printf '%s\n' x y z >"$work/right"
[ "$(paste "$work/left" "$work/right" | head -n1)" = "$(printf '1\tx')" ] || fail "paste failed"

# sha256sum round-trips through -c (relative names, as checklists are normally
# written). A plain cd is used rather than a ( subshell ), which would need
# fork.
cd "$work" || fail "cd into work dir failed"
printf 'coreutils on wasm\n' >payload
sha256sum payload >payload.sha256 || fail "sha256sum failed"
sha256sum -c payload.sha256 >/dev/null || fail "sha256sum -c failed"
# Corrupt it and confirm the check now fails.
printf 'tampered\n' >payload
if sha256sum -c payload.sha256 >/dev/null 2>&1; then
  fail "sha256sum -c accepted a tampered file"
fi
cd / || fail "cd back failed"

# expr arithmetic and string ops. expr is deliberately under test here, so the
# "expr is antiquated" style advice does not apply.
# shellcheck disable=SC2003 # expr is deliberately the command under test
[ "$(expr 6 \* 7)" -eq 42 ] || fail "expr multiplication failed"
# shellcheck disable=SC2003 # expr is deliberately the command under test
[ "$(expr abcde : '.*')" -eq 5 ] || fail "expr string match failed"

# printf.
[ "$(printf '%03d-%s' 7 hi)" = "007-hi" ] || fail "printf failed"

# env sets and reports a variable.
[ "$(env COREUTILS_TEST=ok env | grep '^COREUTILS_TEST=')" = "COREUTILS_TEST=ok" ] ||
  fail "env did not pass the variable through"

# date parses an epoch offset.
date -u -d @0 >/tmp/date-out 2>/dev/null || fail "date -d @0 failed"
grep -q 1970 /tmp/date-out || fail "date -d @0 did not resolve to the epoch"

echo "::vm-test::pass"
while :; do :; done
